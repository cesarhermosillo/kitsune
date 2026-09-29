import { describe, test, expect } from "vitest";
import { parseSse, retryDelay, startClient } from "./client";

describe("client", () => {
  test("parseSse separa bloques, ignora comentarios y conserva el resto", () => {
    expect(parseSse(": ok\n\ndata: {\"a\":1}\n\ndata: {\"b\"")).toEqual({
      events: ['{"a":1}'],
      rest: 'data: {"b"',
    });
  });

  test("retryDelay: 5 s el primer minuto, luego 30 s", () => {
    expect(retryDelay(0)).toBe(5000);
    expect(retryDelay(59_999)).toBe(5000);
    expect(retryDelay(60_000)).toBe(30000);
  });

  test("reconecta y pide /state tras perder el stream", async () => {
    const calls: string[] = [];
    const connected: boolean[] = [];
    let round = 0;
    const encoder = new TextEncoder();
    const fakeFetch = (async (url: string) => {
      calls.push(url.replace("http://k", ""));
      if (url.endsWith("/state"))
        return new Response(
          JSON.stringify({ triaging: false, pending: [], sessions: [], lastError: null })
        );
      round++;
      const body = new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              ': ok\n\ndata: {"type":"session_done","name":"x","at":1}\n\n'
            )
          );
          c.close();
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    const events: unknown[] = [];
    let client: { stop(): void } | null = null;
    await new Promise<void>((done) => {
      client = startClient({
        baseUrl: "http://k",
        token: async () => "t",
        fetch: fakeFetch,
        onSnapshot: () => {},
        onEvent: (e) => events.push(e),
        onConnected: (c) => connected.push(c),
        sleep: async () => {
          if (round >= 2) {
            client?.stop();
            done();
          }
        },
        now: () => 0,
      });
    });
    expect(calls).toEqual(["/state", "/events", "/state", "/events"]);
    expect(connected).toEqual([true, false, true, false]);
    expect(events).toHaveLength(2);
  });
});
