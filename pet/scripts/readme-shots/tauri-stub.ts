// Stand-in for @tauri-apps/api/{core,event,window} in the README screenshot harness.
// Nothing here talks to Tauri or to the Kitsune daemon.
export async function invoke<T>(cmd: string): Promise<T> {
  if (cmd === "read_pet_token") return "fake-token" as T;
  if (cmd === "cursor_in_window") return null as T;
  return undefined as T;
}

export async function listen(): Promise<() => void> {
  return () => {};
}

export function getCurrentWindow() {
  return {
    startDragging: async () => {},
    onMoved: async () => () => {},
  };
}
