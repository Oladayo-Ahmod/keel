// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {TrozuBase} from "./TrozuBase.sol";
import {TrozuVault} from "../../src/v2/TrozuVault.sol";
import {PositionLens} from "../../src/PositionLens.sol";

/// Golden vectors for the guardian's planner.
///
/// It builds many random positions on the local MUSD deployment, puts each in a random guardian state (policy,
/// reserve, spent allowance, window, price move, redemption queue), asks the vault's own `preview()` what it
/// would do, and writes the state and the answer to web/src/lib/__fixtures__/planner-vectors.json. The web app's
/// what-if simulator has a TypeScript port of the planner; its tests replay every vector against the port, so a
/// divergence between the two fails there. The generation is deterministic (a hash of the vector number is the
/// only source of randomness), so the file only changes when the contract or this test does, and CI checks that.
///
/// Some modes aim at one branch each, and the test fails if any branch the port has to match was never reached.
contract PlannerVectorsTest is TrozuBase {
    uint256 internal constant N = 520;
    string internal constant FILE = "web/src/lib/__fixtures__/planner-vectors.json";
    uint256 internal holderKey = 0xA11CE;
    address internal holder;

    // scenario knobs, kept in one struct so the helpers stay under the stack limit
    struct Sc {
        uint256 i;
        uint256 mode;
        uint256 price0; // USD, for the opening price
        uint256 icr0; // ratio the position is opened at, 1e18
        TrozuVault vault;
        uint256 id;
        uint256 queue; // troves put ahead of this one in the redemption queue
        string state; // none | stale | live
        bool closed;
    }

    function rnd(uint256 i, string memory salt, uint256 mod) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(i, salt))) % mod;
    }

    function _pick(uint256 i, string memory salt, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + rnd(i, salt, hi - lo + 1);
    }

    function test_writePlannerVectors() public {
        holder = vm.addr(holderKey);
        // one line per vector, appended as it is made: building the whole file in memory runs the EVM out of it
        vm.writeFile(FILE, "[");
        uint256 made;
        uint256 skipped;
        // kept in memory: the loop reverts the chain every round, which would wipe any storage counter
        string[] memory allTags = new string[](N);
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < N; i++) {
            vm.revertToState(snap);
            snap = vm.snapshotState();
            try this.vec(i) returns (string memory js, string memory tags) {
                vm.writeLine(FILE, string.concat(made == 0 ? "" : ",", js));
                allTags[made] = tags;
                made++;
            } catch {
                skipped++; // a random state Mezo or the vault refused to build; the next number is tried
            }
        }
        vm.writeLine(FILE, "]");
        emit log_named_uint("vectors written", made);
        emit log_named_uint("states skipped", skipped);

        assertGe(made, 400, "too few vectors");
        string[22] memory need = [
            "kind-topup", "kind-repay", "kind-defend", "hold-healthy", "reason-below-minimum", "reason-no-reserve",
            "reason-buffer-unknown", "reason-no-policy", "reason-stale", "reason-inactive", "verdict-above",
            "verdict-below", "verdict-unknown", "bind-need", "bind-reserve", "bind-period", "bind-maxaction",
            "bind-mindebt", "tip-paid", "tip-dust", "tip-reserve-short", "recovery-mode"
        ];
        for (uint256 k; k < need.length; k++) {
            assertTrue(_reached(allTags, made, need[k]), string.concat("no vector reached: ", need[k]));
        }
    }

    function _reached(string[] memory all, uint256 n, string memory tag) internal pure returns (bool) {
        for (uint256 j; j < n; j++) if (_hasTag(all[j], tag)) return true;
        return false;
    }

    /// Whether a comma separated list holds exactly this tag.
    function _hasTag(string memory tags, string memory tag) internal pure returns (bool) {
        bytes memory b = bytes(tags);
        bytes32 want = keccak256(bytes(tag));
        uint256 start;
        for (uint256 p; p <= b.length; p++) {
            if (p == b.length || b[p] == ",") {
                bytes memory t = new bytes(p - start);
                for (uint256 q; q < t.length; q++) t[q] = b[start + q];
                if (keccak256(t) == want) return true;
                start = p + 1;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------------------------------------------------
    // one vector
    // ---------------------------------------------------------------------------------------------------------

    function vec(uint256 i) external returns (string memory js, string memory tags) {
        Sc memory s;
        s.i = i;
        s.mode = i % 11;
        s.state = "live";
        _build(s);
        (js, tags) = _read(s);
    }

    function _build(Sc memory s) internal {
        uint256 i = s.i;
        // opening price and ratio
        s.price0 = _pick(i, "p0", 30_000, 90_000);
        s.icr0 = _pick(i, "icr0", 1.3e18, 2.4e18);
        aggregator.setPrice(s.price0 * 1e8);

        // position: the debt mode 8 uses is close to Mezo's minimum so a repay is bound by it
        uint256 debt = s.mode == 8 ? _pick(i, "d", 1800e18, 1850e18) : _pick(i, "d", 1800e18, 6000e18);
        uint256 composite = (debt * 1005) / 1000 + 200e18;
        uint256 coll = (s.icr0 * composite) / (s.price0 * 1e18);
        (s.id, s.vault) = _open(holder, debt, coll);

        _queueAhead(s, debt);
        _reserve(s);
        TrozuVault.Policy memory p = _policyFor(s);

        // special states
        if (s.mode == 9) {
            uint256 pick = rnd(i, "special", 4);
            if (pick == 0) s.state = "none";
            else if (pick == 1) s.state = "stale";
            else if (pick == 2) s.closed = true;
        }
        if (!_eq(s.state, "none")) {
            vm.prank(holder);
            s.vault.setPolicy(p);
        }
        if (_eq(s.state, "stale")) {
            vm.prank(holder);
            nft.transferFrom(holder, bob, s.id);
        }
        if (s.closed) {
            _fundMusd(holder, 30_000e18);
            vm.startPrank(holder);
            musd.approve(address(s.vault), type(uint256).max);
            s.vault.close();
            vm.stopPrank();
        }

        _window(s, p);
        _moveTime(s);
        if (!s.closed) _movePrice(s, p);
    }

    /// Troves with a lower ratio than this one sit ahead of it in the redemption queue.
    function _queueAhead(Sc memory s, uint256) internal {
        uint256 k;
        if (s.mode == 5) k = _pick(s.i, "k", 2, 6);
        else if (s.mode == 6) k = _pick(s.i, "k", 3, 7);
        else if (s.mode == 7) k = _pick(s.i, "k", 2, 6);
        else k = rnd(s.i, "k", 6);
        if (s.icr0 < 1.25e18) k = 0;
        s.queue = k;
        for (uint256 j; j < k; j++) {
            uint256 qDebt = _pick(s.i, string.concat("qd", vm.toString(j)), 1900e18, 3600e18);
            uint256 qIcr = _pick(s.i, string.concat("qi", vm.toString(j)), 1.13e18, s.icr0 - 0.02e18);
            uint256 coll = (qIcr * ((qDebt * 1005) / 1000 + 200e18)) / (s.price0 * 1e18);
            openBackgroundTrove(makeAddr(string.concat("q", vm.toString(j))), qDebt, coll);
        }
    }

    function _reserve(Sc memory s) internal {
        uint256 i = s.i;
        uint256 btc = rnd(i, "rz", 5) == 0 ? 0 : _pick(i, "rb", 0.0002e18, 0.2e18);
        uint256 musdAmt = rnd(i, "rmz", 4) == 0 ? 0 : _pick(i, "rm", 5e18, 1500e18);
        if (s.mode == 2) btc = _pick(i, "rb2", 0.00001e18, 0.0006e18); // reserve is the binding limit
        if (s.mode == 8) btc = 0; // only a repay is possible
        if (s.mode == 8) musdAmt = _pick(i, "rm8", 300e18, 3000e18);
        if (btc > 0) {
            vm.deal(holder, holder.balance + btc);
            vm.prank(holder);
            s.vault.fundReserveBtc{value: btc}();
        }
        if (musdAmt > 0) {
            _fundMusd(holder, musdAmt);
            vm.startPrank(holder);
            musd.approve(address(s.vault), musdAmt);
            s.vault.fundReserveMusd(musdAmt);
            vm.stopPrank();
        }
    }

    function _policyFor(Sc memory s) internal view returns (TrozuVault.Policy memory p) {
        uint256 i = s.i;
        p.floorIcr = _pick(i, "fl", 1.15e18, 1.8e18);
        p.targetIcr = p.floorIcr + _pick(i, "tg", 0.03e18, 0.6e18);
        p.maxActionBtc = rnd(i, "mbz", 7) == 0 ? 0 : _pick(i, "mb", 0.0005e18, 0.06e18);
        p.maxActionMusd = rnd(i, "mmz", 7) == 0 ? 0 : _pick(i, "mm", 5e18, 1200e18);
        if (s.mode == 4) p.maxActionBtc = _pick(i, "mb4", 0.0003e18, 0.0015e18); // the per-action cap binds
        if (s.mode == 8) p.maxActionMusd = _pick(i, "mm8", 200e18, 1200e18);
        if (s.mode == 1) {
            p.maxActionBtc = _pick(i, "mb1", 0.00005e18, 0.0004e18); // too small to lift a ratio near 110%
            p.maxActionMusd = _pick(i, "mm1", 3e18, 30e18);
        }
        if (p.maxActionBtc == 0 && p.maxActionMusd == 0) p.maxActionBtc = 0.01e18;
        p.periodCapBtc = p.maxActionBtc + (rnd(i, "pcz", 4) == 0 ? 0 : _pick(i, "pc", 0.0001e18, 0.15e18));
        p.periodCapMusd = p.maxActionMusd + (rnd(i, "pmz", 4) == 0 ? 0 : _pick(i, "pm", 10e18, 1500e18));
        p.keeperTipBtc = rnd(i, "tz", 5) == 0 ? 0 : _pick(i, "tp", 1e12, 1e14);
        if (s.mode == 10) p.keeperTipBtc = _pick(i, "tp10", 5e13, 1e14); // big tip, so a small action is dust
        if (p.keeperTipBtc >= p.periodCapBtc && p.keeperTipBtc > 0) p.periodCapBtc = p.keeperTipBtc + p.maxActionBtc + 1;
        p.period = uint32(_pick(i, "pd", 1 hours, 30 days));
        bool defense = s.mode == 5 || s.mode == 6 || s.mode == 7 || (s.mode == 0 && rnd(i, "df", 3) == 0);
        if (defense) {
            if (p.maxActionBtc == 0) p.maxActionBtc = _pick(i, "mbd", 0.002e18, 0.05e18);
            if (p.periodCapBtc < p.maxActionBtc) p.periodCapBtc = p.maxActionBtc + _pick(i, "pcd", 0.001e18, 0.1e18);
            if (p.keeperTipBtc >= p.periodCapBtc) p.keeperTipBtc = 0;
            p.maxWalkSteps = uint16(s.mode == 6 ? _pick(i, "w6", 1, 2) : _pick(i, "w", 8, 40));
            if (s.mode == 5) p.bufferFloorMusd = _pick(i, "bf5", 40_000e18, 90_000e18); // above any queue here: Below
            else if (s.mode == 7) p.bufferFloorMusd = _pick(i, "bf7", 100e18, 900e18); // under the first trove ahead: Above
            else p.bufferFloorMusd = _pick(i, "bf", 500e18, 20_000e18);
        }
    }

    /// The spending window: when it started and what has been spent in it. `setPolicy` zeroes both, so this writes them straight to storage.
    function _window(Sc memory s, TrozuVault.Policy memory p) internal {
        if (!_eq(s.state, "live") || s.closed) return;
        uint256 i = s.i;
        uint256 start = rnd(i, "ws", 3) == 0 ? 0 : block.timestamp > p.period ? block.timestamp - rnd(i, "wa", uint256(p.period) + p.period / 2) : 0;
        uint256 sBtc = rnd(i, "sb", 3) == 0 ? 0 : rnd(i, "sbv", p.periodCapBtc + 1);
        uint256 sMusd = rnd(i, "sm", 3) == 0 ? 0 : rnd(i, "smv", p.periodCapMusd + 1);
        if (s.mode == 3) {
            start = block.timestamp > 100 ? block.timestamp - 50 : 0; // inside the window
            sBtc = p.periodCapBtc - rnd(i, "s3", p.periodCapBtc / 2 + 1); // little left
        }
        vm.store(address(s.vault), bytes32(uint256(15)), bytes32(start));
        vm.store(address(s.vault), bytes32(uint256(16)), bytes32(sBtc));
        vm.store(address(s.vault), bytes32(uint256(17)), bytes32(sMusd));
        // the storage layout is part of what this test relies on: check it took
        assertEq(s.vault.periodStart(), uint64(start), "periodStart slot");
        assertEq(s.vault.spentBtc(), sBtc, "spentBtc slot");
        assertEq(s.vault.spentMusd(), sMusd, "spentMusd slot");
    }

    function _moveTime(Sc memory s) internal {
        // interest accrues, and the window may have ended
        vm.warp(block.timestamp + rnd(s.i, "warp", 90 days));
    }

    function _movePrice(Sc memory s, TrozuVault.Policy memory p) internal {
        uint256 i = s.i;
        (uint256 coll, uint256 prin, uint256 intr,,,) = troveManager.getEntireDebtAndColl(address(s.vault));
        uint256 debt = prin + intr;
        uint256 icrTarget;
        if (s.mode == 1) icrTarget = _pick(i, "t1", 1.01e18, 1.098e18); // under the floor and close to liquidation
        else if (s.mode == 10) icrTarget = p.floorIcr - _pick(i, "t10", 1e14, 3e15); // a hair under the floor
        else if (s.mode >= 5 && s.mode <= 7) icrTarget = _pick(i, "t5", p.floorIcr + 0.01e18, p.targetIcr - 0.005e18);
        else if (s.mode == 8) icrTarget = _pick(i, "t8", 1.12e18, p.floorIcr - 0.01e18);
        else if (s.mode == 3 || s.mode == 4 || s.mode == 2) icrTarget = _pick(i, "t2", 1.12e18, p.floorIcr - 0.005e18);
        else icrTarget = _pick(i, "t0", 1.02e18, 2.6e18);
        if (icrTarget >= p.targetIcr && s.mode >= 5 && s.mode <= 7) icrTarget = p.floorIcr + 0.005e18;
        uint256 p18 = (icrTarget * debt) / coll;
        if (p18 < 1e8 * 1e10) p18 = 1e8 * 1e10;
        aggregator.setPrice(p18 / 1e10);
    }

    // ---------------------------------------------------------------------------------------------------------
    // read the contract and write the vector
    // ---------------------------------------------------------------------------------------------------------

    struct St {
        bool active;
        uint256 coll;
        uint256 debt;
        uint256 price;
        uint256 minIcr;
        bool recovery;
        PositionLens.Buffer buf;
        PositionLens.Verdict verdict;
        bool verdictRead;
        TrozuVault.Policy pol;
        uint256 reserveBtc;
        uint256 reserveMusd;
        uint256 spentBtc;
        uint256 spentMusd;
        uint256 periodStart;
        uint256 minNetDebt;
    }

    function _read(Sc memory s) internal returns (string memory js, string memory tags) {
        St memory t;
        TrozuVault v = s.vault;
        (t.coll, t.debt) = _collDebt(address(v));
        t.active = uint8(troveManager.getTroveStatus(address(v))) == 1;
        t.price = priceFeed.fetchPrice();
        t.minIcr = 1.1e18;
        t.recovery = troveManager.checkRecoveryMode(t.price);
        if (t.recovery) {
            uint256 tcr = troveManager.getTCR(t.price);
            if (tcr > t.minIcr) t.minIcr = tcr;
        }
        t.pol = v.policy();
        t.reserveBtc = v.reserveBtc();
        t.reserveMusd = v.reserveMusd();
        t.spentBtc = v.spentBtc();
        t.spentMusd = v.spentMusd();
        t.periodStart = v.periodStart();
        t.minNetDebt = borrowerOperations.minNetDebt();
        if (t.active && uint8(nft.ownerOf(s.id) == holder ? 0 : 1) <= 1) t.buf = lens.redemptionBuffer(s.id, 100);
        if (t.pol.bufferFloorMusd > 0 && t.active) {
            (t.verdict,) = lens.bufferAtLeast(s.id, t.pol.bufferFloorMusd, t.pol.maxWalkSteps);
            t.verdictRead = true;
        }

        TrozuVault.Plan memory pl = v.preview();
        tags = _check(s, t, pl);
        js = _json(s, t, pl, tags);
    }

    function _collDebt(address vault) internal view returns (uint256 c, uint256 d) {
        (uint256 coll, uint256 p, uint256 i,,,) = troveManager.getEntireDebtAndColl(vault);
        return (coll, p + i);
    }

    /// Checks properties that must hold for any answer, and returns the tags that say which branch this vector reached.
    function _check(Sc memory s, St memory t, TrozuVault.Plan memory pl) internal view returns (string memory tags) {
        // nothing is ever offered that the caps or the 110% line forbid
        if (pl.kind == TrozuVault.Kind.None) {
            assertEq(pl.amount, 0, "None carries an amount");
            assertEq(pl.tip, 0, "None carries a tip");
        } else {
            assertLe(pl.tip, t.pol.keeperTipBtc, "tip above the policy's");
            if (pl.kind == TrozuVault.Kind.RepayMusd) {
                assertLe(pl.amount, t.pol.maxActionMusd, "repay above the action cap");
                assertLe(pl.amount, t.reserveMusd, "repay above the reserve");
                assertGe((t.coll * t.price) / (t.debt - pl.amount), t.minIcr, "repay leaves the ratio under the line");
            } else {
                assertLe(pl.amount, t.pol.maxActionBtc, "top-up above the action cap");
                assertLe(pl.amount + pl.tip, t.reserveBtc, "top-up and tip above the reserve");
                assertGe(((t.coll + pl.amount) * t.price) / t.debt, t.minIcr, "top-up leaves the ratio under the line");
            }
        }

        tags = "";
        if (t.recovery) tags = _add(tags, "recovery-mode");
        if (pl.kind == TrozuVault.Kind.TopUpBtc) tags = _add(tags, "kind-topup");
        else if (pl.kind == TrozuVault.Kind.RepayMusd) tags = _add(tags, "kind-repay");
        else if (pl.kind == TrozuVault.Kind.DefendBtc) tags = _add(tags, "kind-defend");
        else {
            tags = _add(tags, string.concat("reason-", _reasonTag(pl.reason)));
            if (pl.reason == TrozuVault.Reason.Healthy) tags = _add(tags, "hold-healthy");
        }
        // redemption verdicts, only where the planner asks
        if (t.verdictRead && t.debt > 0 && (t.coll * t.price) / t.debt >= t.pol.floorIcr && (t.coll * t.price) / t.debt < t.pol.targetIcr && _eq(s.state, "live")) {
            tags = _add(tags, t.verdict == PositionLens.Verdict.Above ? "verdict-above" : t.verdict == PositionLens.Verdict.Below ? "verdict-below" : "verdict-unknown");
        }
        if (pl.kind != TrozuVault.Kind.None) tags = _bind(tags, t, pl);
    }

    function _bind(string memory tags, St memory t, TrozuVault.Plan memory pl) internal view returns (string memory) {
        bool fresh = block.timestamp >= t.periodStart + t.pol.period;
        uint256 remBtc = _sub(t.pol.periodCapBtc, fresh ? 0 : t.spentBtc);
        uint256 remMusd = _sub(t.pol.periodCapMusd, fresh ? 0 : t.spentMusd);
        bool tipConfigured = t.pol.keeperTipBtc > 0;
        bool tipFits = t.reserveBtc >= t.pol.keeperTipBtc && remBtc >= t.pol.keeperTipBtc;
        uint256 tip = tipFits ? t.pol.keeperTipBtc : 0;
        if (tipConfigured && !tipFits) tags = _add(tags, "tip-reserve-short");
        else if (tipConfigured && pl.tip == 0) tags = _add(tags, "tip-dust");
        else if (pl.tip > 0) tags = _add(tags, "tip-paid");

        if (pl.kind == TrozuVault.Kind.RepayMusd) {
            uint256 minDebt = t.minNetDebt + 200e18;
            uint256 need = _sub(t.debt, (t.coll * t.price) / t.pol.targetIcr);
            if (pl.amount == need) return _add(tags, "bind-need");
            if (pl.amount == _sub(t.debt, minDebt)) return _add(tags, "bind-mindebt");
            if (pl.amount == t.reserveMusd) return _add(tags, "bind-reserve");
            if (pl.amount == remMusd) return _add(tags, "bind-period");
            return _add(tags, "bind-maxaction");
        }
        uint256 needB = _ceilDiv(t.pol.targetIcr * t.debt, t.price) - t.coll;
        if (pl.amount == needB) return _add(tags, "bind-need");
        if (pl.amount == _sub(t.reserveBtc, tip)) return _add(tags, "bind-reserve");
        if (pl.amount == _sub(remBtc, tip)) return _add(tags, "bind-period");
        return _add(tags, "bind-maxaction");
    }

    function _json(Sc memory s, St memory t, TrozuVault.Plan memory pl, string memory tags) internal view returns (string memory) {
        string memory pol = string.concat(
            '"floorIcr":"', vm.toString(t.pol.floorIcr), '","targetIcr":"', vm.toString(t.pol.targetIcr),
            '","maxActionBtc":"', vm.toString(t.pol.maxActionBtc), '","maxActionMusd":"', vm.toString(t.pol.maxActionMusd),
            '","periodCapBtc":"', vm.toString(t.pol.periodCapBtc), '","periodCapMusd":"', vm.toString(t.pol.periodCapMusd)
        );
        pol = string.concat(
            pol, '","keeperTipBtc":"', vm.toString(t.pol.keeperTipBtc), '","bufferFloorMusd":"', vm.toString(t.pol.bufferFloorMusd),
            '","period":', vm.toString(uint256(t.pol.period)), ',"maxWalkSteps":', vm.toString(uint256(t.pol.maxWalkSteps)),
            ',"reserveBtc":"', vm.toString(t.reserveBtc), '","reserveMusd":"', vm.toString(t.reserveMusd)
        );
        pol = string.concat(
            pol, '","spentBtc":"', vm.toString(t.spentBtc), '","spentMusd":"', vm.toString(t.spentMusd),
            '","periodStart":"', vm.toString(t.periodStart), '"'
        );
        string memory buf = t.active
            ? string.concat(
                '{"inList":', t.buf.inList ? "true" : "false", ',"value":"', vm.toString(t.buf.buffer), '","complete":',
                t.buf.complete ? "true" : "false", ',"steps":', vm.toString(uint256(t.buf.steps)), "}"
            )
            : "null";
        string memory verdict = t.verdictRead ? (t.verdict == PositionLens.Verdict.Above ? "Above" : t.verdict == PositionLens.Verdict.Below ? "Below" : "Unknown") : "None";
        string memory state = string.concat(
            '{"active":', t.active ? "true" : "false", ',"coll":"', vm.toString(t.coll), '","debt":"', vm.toString(t.debt),
            '","price":"', vm.toString(t.price), '","now":"', vm.toString(block.timestamp), '","minNetDebt":"', vm.toString(t.minNetDebt),
            '","minIcr":"', vm.toString(t.minIcr), '","policyState":"', s.state, '","policy":{', pol, "},"
        );
        state = string.concat(state, '"buffer":', buf, ',"verdict":"', verdict, '"}');
        string memory expected = string.concat(
            '{"kind":', vm.toString(uint256(uint8(pl.kind))), ',"reason":', vm.toString(uint256(uint8(pl.reason))),
            ',"amount":"', vm.toString(pl.amount), '","tip":"', vm.toString(pl.tip), '","icr":"', vm.toString(pl.icr),
            '","resetWindow":', pl.resetWindow ? "true" : "false", "}"
        );
        return string.concat('  {"id":', vm.toString(s.i), ',"mode":', vm.toString(s.mode), ',"tags":"', tags, '","state":', state, ',"expected":', expected, "}");
    }

    // ---- small helpers

    function _reasonTag(TrozuVault.Reason r) internal pure returns (string memory) {
        if (r == TrozuVault.Reason.NoPolicy) return "no-policy";
        if (r == TrozuVault.Reason.PolicyStale) return "stale";
        if (r == TrozuVault.Reason.TroveInactive) return "inactive";
        if (r == TrozuVault.Reason.NoPrice) return "no-price";
        if (r == TrozuVault.Reason.Healthy) return "healthy";
        if (r == TrozuVault.Reason.BufferUnknown) return "buffer-unknown";
        if (r == TrozuVault.Reason.NoReserve) return "no-reserve";
        if (r == TrozuVault.Reason.BelowMinimum) return "below-minimum";
        return "none";
    }

    function _add(string memory tags, string memory tag) internal pure returns (string memory) {
        return bytes(tags).length == 0 ? tag : string.concat(tags, ",", tag);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _sub(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }
}
