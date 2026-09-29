import { describe, test, expect, vi, afterEach } from "vitest";
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

  test("I5: pasa el motivo del error a onConnected(false, motivo)", async () => {
    const seen: Array<[boolean, string | undefined]> = [];
    let client: { stop(): void } | null = null;
    await new Promise<void>((done) => {
      client = startClient({
        baseUrl: "http://k",
        token: () => Promise.reject("No encuentro ~/.kitsune/pet-token (¿Kitsune está corriendo?)"),
        fetch: (async () => { throw new Error("no debería llamarse"); }) as unknown as typeof fetch,
        onSnapshot: () => {},
        onEvent: () => {},
        onConnected: (c, r) => seen.push([c, r]),
        sleep: async () => { client?.stop(); done(); },
        now: () => 0,
      });
    });
    expect(seen).toEqual([[false, "No encuentro ~/.kitsune/pet-token (¿Kitsune está corriendo?)"]]);
  });

  test("I5: un 401 se reporta como problema de token y un Error conserva su mensaje", async () => {
    const reasons: Array<string | undefined> = [];
    let n = 0;
    let client: { stop(): void } | null = null;
    await new Promise<void>((done) => {
      client = startClient({
        baseUrl: "http://k",
        token: async () => "t",
        fetch: (async () => {
          if (n++ === 0) return new Response("", { status: 401 });
          throw new TypeError("Load failed");
        }) as unknown as typeof fetch,
        onSnapshot: () => {},
        onEvent: () => {},
        onConnected: (_c, r) => reasons.push(r),
        sleep: async () => { if (n >= 2) { client?.stop(); done(); } },
        now: () => 0,
      });
    });
    expect(reasons[0]).toMatch(/token/i);
    expect(reasons[1]).toBe("Load failed");
  });
});

describe("client: vigilancia del stream (m3)", () => {
  afterEach(() => { vi.useRealTimers(); });

  test("sin bytes durante 45 s aborta y reconecta; cada latido reinicia el plazo", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const calls: string[] = [];
    const connected: boolean[] = [];
    let push: ((s: string) => void) | null = null;
    const fakeFetch = (async (url: string) => {
      calls.push(url.replace("http://k", ""));
      if (url.endsWith("/state"))
        return new Response(JSON.stringify({ triaging: false, pending: [], sessions: [], lastError: null }));
      const body = new ReadableStream<Uint8Array>({
        start(c) { push = (s) => c.enqueue(encoder.encode(s)); },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    let slept = false;
    const client = startClient({
      baseUrl: "http://k",
      token: async () => "t",
      fetch: fakeFetch,
      onSnapshot: () => {},
      onEvent: () => {},
      onConnected: (c) => connected.push(c),
      sleep: async () => { slept = true; },
      now: () => 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["/state", "/events"]);
    await vi.advanceTimersByTimeAsync(30_000);
    push!(": hb\n\n");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(slept).toBe(false);
    expect(connected).toEqual([true]);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(connected.slice(0, 2)).toEqual([true, false]);
    expect(calls.slice(0, 4)).toEqual(["/state", "/events", "/state", "/events"]);
    client.stop();
  });
});
