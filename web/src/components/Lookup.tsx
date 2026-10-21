"use client";

import { useState } from "react";
import { usePositionById } from "@/hooks/usePositions";
import { PositionList } from "./PositionList";

/** Reads any position by NFT id, with no wallet connected. */
export function Lookup() {
  const [text, setText] = useState("");
  const [id, setId] = useState<bigint | undefined>();
  const [bad, setBad] = useState(false);
  const state = usePositionById(id);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{1,18}$/.test(text.trim())) {
      setBad(true);
      return;
    }
    setBad(false);
    setId(BigInt(text.trim()));
  };

  return (
    <section className="lookup" aria-label="Look up a position">
      <form onSubmit={submit} className="lookup-form">
        <label htmlFor="nft-id">Look up a position by NFT id</label>
        <div className="lookup-row">
          <input
            id="nft-id"
            inputMode="numeric"
            placeholder="1"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={bad}
            aria-describedby={bad ? "nft-id-err" : undefined}
          />
          <button className="btn" type="submit">
            Look up
          </button>
        </div>
        {bad && (
          <p id="nft-id-err" className="note warn" role="alert">
            Enter a whole number, for example 1.
          </p>
        )}
      </form>
      {id !== undefined && (
        <PositionList
          state={state}
          idle={null}
          empty={<p className="note">No position with that id.</p>}
        />
      )}
    </section>
  );
}
