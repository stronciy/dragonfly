/**
 * Читає multipart-тіло один раз цілком і збирає FormData з буфера.
 * Прямий req.formData() на деяких шляхах Next.js (загрузка з мобільного клієнта)
 * дає «Response body object should not be disturbed or locked».
 */
export async function readMultipartForm(req: Request): Promise<FormData> {
  const buffer = await req.arrayBuffer();
  const contentType = req.headers.get("content-type") ?? "";
  return new Response(buffer, { headers: { "content-type": contentType } }).formData();
}
