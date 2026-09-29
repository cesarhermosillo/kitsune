// Cliente para los endpoints de acciones del daemon (§ propuestas: opciones, lanzar, rechazar, reintentar).

export interface WorkflowChoice {
  id: string;
  name: string;
  suggested: boolean;
  favorite: boolean;
  dangerous: boolean;
  group: "main" | "other";
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string };

export interface ApiDeps {
  baseUrl: string;
  token: () => Promise<string>;
  fetch: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 150_000;

export async function apiCall<T>(
  deps: ApiDeps,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<ApiResult<T>> {
  let token: string;
  try {
    token = await deps.token();
  } catch {
    return { ok: false, status: 0, code: "unreachable", message: "Kitsune no responde" };
  }

  const headers: Record<string, string> = { "x-kitsune-token": token };
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await deps.fetch(`${deps.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, code: "unreachable", message: "Kitsune no responde" };
  }

  if (!res.ok) {
    try {
      const parsed = (await res.json()) as { code?: string; message?: string };
      if (parsed && typeof parsed.code === "string" && typeof parsed.message === "string") {
        return { ok: false, status: res.status, code: parsed.code, message: parsed.message };
      }
    } catch {
      /* cuerpo no es JSON válido: cae al fallback genérico */
    }
    return {
      ok: false,
      status: res.status,
      code: `http_${res.status}`,
      message: `Error ${res.status}`,
    };
  }

  try {
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, status: res.status, code: "bad_response", message: "Respuesta inválida de Kitsune" };
  }
}

export const getOptions = (deps: ApiDeps, id: string) =>
  apiCall<{ title: string; choices: WorkflowChoice[] }>(
    deps,
    "GET",
    `/proposals/${encodeURIComponent(id)}/options`
  );

export const launchProposal = (deps: ApiDeps, id: string, workflowId: string) =>
  apiCall<{ status: "launched"; sessionName: string }>(
    deps,
    "POST",
    `/proposals/${encodeURIComponent(id)}/launch`,
    { workflowId }
  );

export const rejectProposal = (deps: ApiDeps, id: string) =>
  apiCall<{ status: "rejected" }>(deps, "POST", `/proposals/${encodeURIComponent(id)}/reject`);

export const retryProposal = (deps: ApiDeps, id: string) =>
  apiCall<{ status: "launched"; sessionName: string }>(
    deps,
    "POST",
    `/proposals/${encodeURIComponent(id)}/retry`
  );
