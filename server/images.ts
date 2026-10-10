import { ServiceError } from "lib/compat/error";
import { Id } from "lib/typedModel/regexes";

// As much of Jolly Roger's image handling as checking a node needs: which
// bucket images live in and whether a url is one of ours. Uploads, and the
// policy endpoint that signs them, come with their own workstream.

export interface ImageBucket {
  bucketName: string;
  bucketRegion: string;
}

// The S3 bucket images are uploaded to, if one is configured
// (S3_IMAGE_BUCKET_NAME and S3_IMAGE_BUCKET_REGION in the environment).
export function imageBucket(): ImageBucket | undefined {
  const bucketName = process.env.S3_IMAGE_BUCKET_NAME;
  const bucketRegion = process.env.S3_IMAGE_BUCKET_REGION;
  return bucketName && bucketRegion ? { bucketName, bucketRegion } : undefined;
}

// Where an object in the image bucket can be read from. Each segment of the
// key is encoded, so a filename's own "#", "?" or "%" stays in the path.
export const imageObjectUrl = (bucket: ImageBucket, key: string) =>
  `https://s3.${bucket.bucketRegion}.amazonaws.com/${bucket.bucketName}/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

// Whether url is an object in the image bucket, with no way out of it.
export function isImageObjectUrl(bucket: ImageBucket, url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const base = new URL(imageObjectUrl(bucket, ""));
  return (
    parsed.origin === base.origin &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname.startsWith(base.pathname) &&
    url.startsWith(base.href)
  );
}

// Images on the board are objects uploaded as Jolly Roger's chat images are:
// in the image bucket, keyed by this hunt's id, a puzzle's id and the
// upload's own. That keeps readers' browsers from fetching anything from
// anywhere else, and keeps another hunt's images (which go when that hunt is
// purged) out. Anything else, including when there's no bucket, is refused.
export async function assertStoredImages(huntId: string, urls: string[]) {
  if (urls.length === 0) return;
  const bucket = imageBucket();
  const prefix = bucket ? imageObjectUrl(bucket, "") : undefined;
  urls.forEach((url) => {
    const key =
      prefix && url.startsWith(prefix) ? url.slice(prefix.length) : "";
    const parts = key.split("/");
    if (
      parts.length !== 3 ||
      parts[0] !== huntId ||
      !parts.every((part) => Id.test(part))
    ) {
      throw new ServiceError(400, "That image isn't one we stored");
    }
  });
}
