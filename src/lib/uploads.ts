import { ApiError } from "@/shared";

export async function readFormFileAsDataUrl(formData: FormData, fieldName: string) {
  const value = formData.get(fieldName);
  if (!(value instanceof File)) throw new ApiError(400, "VALIDATION_ERROR", `${fieldName}: файл обов'язковий`);
  return fileToDataUrl(value, fieldName);
}

export async function readFormFilesAsDataUrl(formData: FormData, fieldName: string, maxCount: number) {
  const values = formData.getAll(fieldName).filter((v): v is File => v instanceof File);
  if (values.length > maxCount) {
    throw new ApiError(400, "VALIDATION_ERROR", `Забагато файлів (макс. ${maxCount})`);
  }
  const out = [];
  for (const value of values) {
    out.push(await fileToDataUrl(value, fieldName));
  }
  return out;
}

async function fileToDataUrl(value: File, fieldName: string) {
  const buf = Buffer.from(await value.arrayBuffer());
  if (buf.byteLength === 0) throw new ApiError(400, "VALIDATION_ERROR", "Порожній файл");
  if (buf.byteLength > 10 * 1024 * 1024) throw new ApiError(400, "VALIDATION_ERROR", "Файл завеликий");

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
