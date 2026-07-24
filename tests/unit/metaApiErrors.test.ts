import { describe, expect, it } from "vitest";
import { publicMetaApiError } from "@/lib/broker/metaApiErrors";

describe("publicMetaApiError", () => {
  it("turns broker connection timeouts into a retry-safe message", () => {
    expect(publicMetaApiError(
      "Timed out waiting for account 3872bcac-40e1-4cfc-ae2f-3879ee88c890 to connect to the broker",
    )).toBe(
      "The broker connection is temporarily unavailable. Automatic synchronization will keep retrying in the background.",
    );
  });

  it("treats duplicate synchronization as already in progress", () => {
    expect(publicMetaApiError(
      "It looks like synchronization with this synchronization id is already running.",
    )).toBe(
      "Broker synchronization is already in progress. The existing synchronization will continue.",
    );
  });

  it("removes provider UUIDs from unknown public errors", () => {
    expect(publicMetaApiError(
      "Provider 3872bcac-40e1-4cfc-ae2f-3879ee88c890 returned an unexpected response.",
    )).toBe("Provider provider account returned an unexpected response.");
  });
});
