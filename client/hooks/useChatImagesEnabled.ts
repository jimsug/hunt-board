import { useTracker, welcome } from "client/store";

// Whether the server has somewhere to store images. It says so in the
// welcome; until uploads have their workstream it says no.
export default function useChatImagesEnabled(): boolean {
  return useTracker(() => welcome.get()?.imagesEnabled ?? false, []);
}
