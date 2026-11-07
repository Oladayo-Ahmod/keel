import { describe, expect, it } from "vitest";
import { buildPayload, post } from "../src/webhook.js";

/**
 * Posts one real, clearly labelled test message to the webhook in WEBHOOK_TEST_URL, if that is set. It is
 * read from the environment and never printed, logged or put in an assertion message. Off by default:
 *
 *   WEBHOOK_TEST_URL=https://... npm run test:live -w @trozu/alerts
 *
 * Passing means the service answered 2xx, not that a person saw the message.
 */
describe.skipIf(!process.env.WEBHOOK_TEST_URL)("a real webhook", () => {
  it("accepts a test message", async () => {
    const url = process.env.WEBHOOK_TEST_URL!;
    const payload = buildPayload(
      [
        {
          kind: "near-floor",
          severity: "info",
          tokenId: "0",
          vault: "0x0000000000000000000000000000000000000000",
          title: "Trozu alerts: test message",
          message: "This is a test of the webhook from @trozu/alerts. It is not a real alert and nothing needs doing.",
          key: "test",
          data: {},
        },
      ],
      "auto",
      url,
    );
    // post() throws a WebhookError that never carries the url, so a failure shows only the reason
    await expect(post(url, payload)).resolves.toBeUndefined();
  }, 30_000);
});
