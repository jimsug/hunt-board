import type { TFunction } from "i18next";
import type { ServiceError } from "lib/compat/error";

// Image uploads wait for their workstream (the service has to sign an S3
// policy itself). Until then this stands where Jolly Roger's uploadChatImage
// stood: every upload fails as the server having nowhere to put images.

export type ChatImageUploadFailure =
  | { stage: "convert"; error: unknown }
  | { stage: "tooBig" }
  | { stage: "request"; error: ServiceError | undefined }
  | { stage: "upload"; error: unknown };

// The reason to show for a failed upload, or undefined when the server has
// nowhere to store images (which callers word their own way).
export function chatImageFailureReason(
  failure: ChatImageUploadFailure,
  t: TFunction,
): string | undefined {
  switch (failure.stage) {
    case "convert":
      return t(
        "chat.images.convertFailed",
        "That image couldn't be read by the browser",
      );
    case "tooBig":
      return t("chat.images.tooBig", "That image is too big to upload");
    case "request":
      return failure.error?.reason;
    case "upload":
      return t("chat.images.uploadFailed", "The upload failed");
    default:
      return failure satisfies never;
  }
}

export default function uploadChatImage(
  _file: File,
  _onDone: (url: string) => void,
  onFail: (failure: ChatImageUploadFailure) => void,
) {
  onFail({ stage: "request", error: undefined });
}
