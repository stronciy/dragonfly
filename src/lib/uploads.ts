import { ApiError } from "@/shared";

function isUploadFile(v: unknown): v is File {
  return (
    v instanceof File ||
    (typeof v === "object" && v !== null && typeof (v as { arrayBuffer?: unknown }).arrayBuffer === "function")
  );
}

export async function readFormFileAsDataUrl(formData: FormData, fieldName: string) {
  const value = formData.get(fieldName);
  if (!isUploadFile(value)) throw new ApiError(400, "VALIDATION_ERROR", `${fieldName}: файл обов'язковий`);
  return fileToDataUrl(value);
}

export async function readFormFilesAsDataUrl(formData: FormData, fieldName: string, maxCount: number) {
  const raw = [
    ...formData.getAll(fieldName),
    ...(fieldName === "files" ? formData.getAll("file") : []),
  ];
  const values = raw.filter(isUploadFile);
  if (values.length > maxCount) {
    throw new ApiError(400, "VALIDATION_ERROR", `Забагато файлів (макс. ${maxCount})`);
  }
  const out = [];
  for (const value of values) {
    out.push(await fileToDataUrl(value));
  }
  return out;
}

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  pdf: "application/pdf",
};

/**
 * Тип файлу: заявлений клієнтом тип, інакше за розширенням, інакше за сигнатурою.
 * Без цього фото з мобільного клієнта зберігалися як application/octet-stream і
 * показувалися як посилання, а не як картинки.
 */
export function detectMimeType(declared: string | undefined, name: string | undefined, buf: Buffer): string {
  const clean = (declared ?? "").toLowerCase();
  if (clean && clean !== "application/octet-stream") return clean;
  const ext = (name ?? "").toLowerCase().split(".").pop() ?? "";
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii").startsWith("GIF87")) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return clean || "application/octet-stream";
}

async function fileToDataUrl(value: File) {
  const buf = Buffer.from(await value.arrayBuffer());
  if (buf.byteLength === 0) throw new ApiError(400, "VALIDATION_ERROR", "Порожній файл");
  if (buf.byteLength > 10 * 1024 * 1024) throw new ApiError(400, "VALIDATION_ERROR", "Файл завеликий");

  const mimeType = detectMimeType(value.type, value.name, buf);
  const base64 = buf.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  return {
    dataUrl,
    mimeType,
    size: buf.byteLength,
    name: value.name || `photo-${Date.now()}.jpg`,
  };
}
