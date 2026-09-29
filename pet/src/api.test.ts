import { describe, test, expect } from "vitest";
import { apiCall, getOptions, launchProposal, rejectProposal, retryProposal } from "./api";
import type { ApiDeps } from "./api";

const deps = (fetchImpl: typeof fetch): ApiDeps => ({
  baseUrl: "http://k",
  token: async () => "t",
  fetch: fetchImpl,
});

describe("apiCall", () => {
  test("GET manda el token y devuelve data en 200", async () => {
    const seen: { url: string; init: RequestInit } = { url: "", init: {} };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.init = init ?? {};
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await apiCall<{ ok: number }>(deps(fetchImpl), "GET", "/options/p1");

    expect(seen.url).toBe("http://k/options/p1");
    expect((seen.init.headers as Record<string, string>)["x-kitsune-token"]).toBe("t");
    expect(res).toEqual({ ok: true, data: { ok: 1 } });
  });

  test("POST manda token, content-type y body serializado", async () => {
    const seen: { init: RequestInit } = { init: {} };
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.init = init ?? {};
      return new Response(JSON.stringify({ status: "launched", sessionName: "s" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await apiCall<{ status: string; sessionName: string }>(
      deps(fetchImpl),
      "POST",
      "/launch/p1",
      { workflowId: "w1" }
    );

    const headers = seen.init.headers as Record<string, string>;
    expect(headers["x-kitsune-token"]).toBe("t");
    expect(headers["content-type"]).toBe("application/json");
    expect(seen.init.body).toBe(JSON.stringify({ workflowId: "w1" }));
    expect(res).toEqual({ ok: true, data: { status: "launched", sessionName: "s" } });
  });

  test("GET sin body no manda content-type", async () => {
    const seen: { init: RequestInit } = { init: {} };
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.init = init ?? {};
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    await apiCall(deps(fetchImpl), "GET", "/options/p1");

    const headers = seen.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
  });

  test("en 409 devuelve el code/message del cuerpo", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: "not_pending", message: "Ya fue resuelta" }), {
        status: 409,
      })) as unknown as typeof fetch;

    const res = await apiCall(deps(fetchImpl), "POST", "/reject/p1");

    expect(res).toEqual({
      ok: false,
      status: 409,
      code: "not_pending",
      message: "Ya fue resuelta",
    });
  });

  test("en error sin cuerpo JSON válido usa http_<status>", async () => {
    const fetchImpl = (async () => new Response("not json", { status: 502 })) as unknown as typeof fetch;

    const res = await apiCall(deps(fetchImpl), "POST", "/launch/p1", { workflowId: "w" });

    expect(res).toEqual({
      ok: false,
      status: 502,
      code: "http_502",
      message: "Error 502",
    });
  });

  test("si fetch lanza (red/timeout) devuelve unreachable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof fetch;

    const res = await apiCall(deps(fetchImpl), "GET", "/options/p1");

    expect(res).toEqual({
      ok: false,
      status: 0,
      code: "unreachable",
      message: "Kitsune no responde",
    });
  });
});

describe("helpers de acciones", () => {
  test("getOptions llama GET /options/:id y tipa la respuesta", async () => {
    const fetchImpl = (async (url: string) =>
      new Response(
        JSON.stringify({
          title: "Elige workflow",
          choices: [{ id: "w1", name: "Fix", suggested: true, favorite: false, dangerous: false, group: "main" }],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const res = await getOptions(deps(fetchImpl), "p1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.title).toBe("Elige workflow");
      expect(res.data.choices[0].id).toBe("w1");
    }
  });

  test("launchProposal llama POST /launch/:id con workflowId", async () => {
    const seen: { url: string; body?: string } = { url: "" };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.body = init?.body as string | undefined;
      return new Response(JSON.stringify({ status: "launched", sessionName: "s1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await launchProposal(deps(fetchImpl), "p1", "w1");

    expect(seen.url).toBe("http://k/launch/p1");
    expect(seen.body).toBe(JSON.stringify({ workflowId: "w1" }));
    expect(res).toEqual({ ok: true, data: { status: "launched", sessionName: "s1" } });
  });

  test("rejectProposal llama POST /reject/:id sin body", async () => {
    const seen: { url: string; body?: string } = { url: "" };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.body = init?.body as string | undefined;
      return new Response(JSON.stringify({ status: "rejected" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await rejectProposal(deps(fetchImpl), "p1");

    expect(seen.url).toBe("http://k/reject/p1");
    expect(seen.body).toBeUndefined();
    expect(res).toEqual({ ok: true, data: { status: "rejected" } });
  });

  test("retryProposal llama POST /retry/:id sin body", async () => {
    const seen: { url: string; body?: string } = { url: "" };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.body = init?.body as string | undefined;
      return new Response(JSON.stringify({ status: "launched", sessionName: "s2" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await retryProposal(deps(fetchImpl), "p1");

    expect(seen.url).toBe("http://k/retry/p1");
    expect(seen.body).toBeUndefined();
    expect(res).toEqual({ ok: true, data: { status: "launched", sessionName: "s2" } });
  });
});
