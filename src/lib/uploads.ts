import { ApiError } from "@/shared";

function isUploadFile(v: unknown): v is File {
  return (
    v instanceof File ||
    (typeof v === "object" && v !== null && typeof (v as any).arrayBuffer === "function")
  );
}

export async function readFormFileAsDataUrl(formData: FormData, fieldName: string) {
  const value = formData.get(fieldName);
  if (!isUploadFile(value)) throw new ApiError(400, "VALIDATION_ERROR", `${fieldName}: файл обов'язковий`);
  return fileToDataUrl(value, fieldName);
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
    name: (value as any).name || `photo-${Date.now()}.jpg`,
  };
}
