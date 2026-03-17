import { ApiError } from "./errors";

export async function readFormFileAsDataUrl(formData: FormData, fieldName: string) {
  const value = formData.get(fieldName);
  if (!(value instanceof File)) throw new ApiError(400, "VALIDATION_ERROR", `${fieldName} file is required`);

  const buf = Buffer.from(await value.arrayBuffer());
  if (buf.byteLength === 0) throw new ApiError(400, "VALIDATION_ERROR", "Empty file");
  if (buf.byteLength > 10 * 1024 * 1024) throw new ApiError(400, "VALIDATION_ERROR", "File too large");

  const mimeType = value.type || "application/octet-stream";
  const base64 = buf.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  return {
    dataUrl,
    mimeType,
    size: buf.byteLength,
    name: value.name,
  };
}
