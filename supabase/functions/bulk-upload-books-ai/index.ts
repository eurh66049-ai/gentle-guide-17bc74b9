// Edge function: bulk-upload-books-ai
// يستقبل كتابًا واحدًا { book } أو دفعة { books }
// يستنتج البيانات عبر Mistral AI، يرفع الغلاف وملف PDF إلى Supabase Storage، ثم ينشر مباشرة ككتاب approved

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface InputBook {
  title: string;
  cover_image_url: string;
  book_file_url: string;
  user_email?: string;
}

interface AIBookMeta {
  author: string;
  category: string;
  description: string;
  language: string;
  publication_year?: number | null;
  page_count?: number | null;
  publisher?: string | null;
  subtitle?: string | null;
  author_bio?: string | null;
}

interface BookResult {
  success: boolean;
  duplicate?: boolean;
  retryable?: boolean;
  error?: string;
  id?: string;
  title?: string;
  cover_image_url?: string | null;
  book_file_url?: string | null;
  cover_uploaded_to_supabase?: boolean;
  book_uploaded_to_supabase?: boolean;
}

const ALLOWED_CATEGORIES = [
  "novels", "history", "philosophy", "religion", "science", "literature",
  "poetry", "biography", "psychology", "politics", "economics", "children",
  "education", "technology", "art", "language", "medicine", "law", "other",
];

const ALLOWED_LANGUAGES = ["ar", "en", "fr", "es", "de", "tr", "other"];
const MISTRAL_BATCH_SIZE = 5;
const FETCH_TIMEOUT = 75_000;
const MAX_FETCH_RETRIES = 3;
const MAX_MISTRAL_RETRIES = 4;
const STORAGE_BASE = () => `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
}

function generateSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\u0600-\u06FFa-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 100) + "-" + Math.random().toString(36).slice(2, 8);
}

function cleanJsonContent(content: string): string {
  return content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function normalizeMeta(meta: Partial<AIBookMeta> | undefined, title: string): AIBookMeta {
  const category = ALLOWED_CATEGORIES.includes(String(meta?.category || ""))
    ? String(meta?.category)
    : "other";
  const language = ALLOWED_LANGUAGES.includes(String(meta?.language || ""))
    ? String(meta?.language)
    : "ar";

  return {
    author: meta?.author?.toString().trim() || "غير معروف",
    category,
    description:
      meta?.description?.toString().trim() ||
      `كتاب ${title} متاح للقراءة والتحميل عبر منصة كتبي.`,
    language,
    publication_year: typeof meta?.publication_year === "number" ? meta.publication_year : null,
    page_count: typeof meta?.page_count === "number" ? meta.page_count : null,
    publisher: meta?.publisher?.toString().trim() || null,
    subtitle: meta?.subtitle?.toString().trim() || null,
    author_bio: meta?.author_bio?.toString().trim() || null,
  };
}

async function fetchWithRetry(url: string, accept: string, retryCount = 0): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; KotobiAIBulkUploader/3.0)",
        Accept: accept,
        "Cache-Control": "no-cache",
        Referer: "https://archive.org/",
      },
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (retryCount < MAX_FETCH_RETRIES) {
      await wait(1_500 * Math.pow(2, retryCount));
      return fetchWithRetry(url, accept, retryCount + 1);
    }
    throw error;
  }
}

async function downloadAndUploadImage(
  url: string,
  supabaseClient: any,
): Promise<string | null> {
  if (!url?.trim() || !isValidUrl(url.trim())) return null;

  try {
    let processedUrl = url.trim();
    if (processedUrl.includes("archive.org") && processedUrl.includes("BookReader")) {
      processedUrl = processedUrl.includes("scale=")
        ? processedUrl.replace(/scale=\d+/, "scale=4")
        : processedUrl + "&scale=4";
    }

    const response = await fetchWithRetry(processedUrl, "image/jpeg, image/png, image/webp, image/*");
    const blob = await response.blob();
    if (blob.size <= 1000 || !blob.type.startsWith("image/")) return null;

    let ext = "jpg";
    if (blob.type.includes("png")) ext = "png";
    else if (blob.type.includes("webp")) ext = "webp";

    const fileName = `covers/${Date.now()}_${Math.random().toString(36).slice(2, 11)}.${ext}`;
    const { error } = await supabaseClient.storage
      .from("book-covers")
      .upload(fileName, blob, {
        contentType: blob.type || "image/jpeg",
        cacheControl: "31536000",
        upsert: false,
      });

    if (error) throw error;
    return `${STORAGE_BASE()}/book-covers/${fileName}`;
  } catch (error) {
    console.error("[AI Bulk] فشل رفع الغلاف:", error);
    return null;
  }
}

async function downloadAndUploadBook(
  url: string,
  supabaseClient: any,
): Promise<{ url: string | null; fileSize: number | null; extension: string; contentType: string }> {
  if (!url?.trim() || !isValidUrl(url.trim())) {
    return { url: null, fileSize: null, extension: "pdf", contentType: "application/pdf" };
  }

  try {
    const response = await fetchWithRetry(url.trim(), "application/pdf, application/octet-stream, */*");
    const blob = await response.blob();
    if (blob.size <= 1000) throw new Error("ملف الكتاب فارغ أو صغير جدًا");

    const contentType = blob.type?.includes("pdf") ? "application/pdf" : blob.type || "application/pdf";
    let ext = "pdf";
    if (contentType.includes("docx")) ext = "docx";
    else if (contentType.includes("msword")) ext = "doc";

    const fileName = `books/${Date.now()}_${Math.random().toString(36).slice(2, 11)}.${ext}`;
    const { error } = await supabaseClient.storage
      .from("book-files")
      .upload(fileName, blob, {
        contentType,
        cacheControl: "31536000",
        upsert: false,
      });

    if (error) throw error;
    return {
      url: `${STORAGE_BASE()}/book-files/${fileName}`,
      fileSize: blob.size,
      extension: ext,
      contentType,
    };
  } catch (error) {
    console.error("[AI Bulk] فشل رفع ملف الكتاب:", error);
    return { url: null, fileSize: null, extension: "pdf", contentType: "application/pdf" };
  }
}

async function inferBooksMetadata(books: InputBook[]): Promise<AIBookMeta[]> {
  const MISTRAL_API_KEY = Deno.env.get("MISTRAL_API_KEY");
  if (!MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY غير مهيأ");

  const systemPrompt = `أنت مساعد يولّد بيانات وصفية دقيقة لكتب عربية وعالمية.
أرجع JSON فقط على شكل: {"books":[...]}. لكل كتاب أعد نفس index.
الحقول المطلوبة لكل عنصر:
- index: رقم الكتاب كما أرسلته
- author: اسم المؤلف الحقيقي إن كان معروفًا، وإلا "غير معروف"
- category: واحد فقط من: ${ALLOWED_CATEGORIES.join(", ")}
- description: وصف عربي مختصر 2-4 جمل
- language: واحد فقط من: ${ALLOWED_LANGUAGES.join(", ")}
- publication_year: رقم أو null
- page_count: رقم تقريبي أو null
- publisher: نص أو null
- subtitle: نص أو null
- author_bio: نبذة عربية قصيرة أو null
لا تضف أي نص خارج JSON ولا تخترع معلومات غير منطقية.`;

  const userPrompt = books
    .map((book, index) => `${index}. ${book.title}`)
    .join("\n");

  let lastError = "فشل Mistral AI";
  for (let attempt = 0; attempt <= MAX_MISTRAL_RETRIES; attempt++) {
    try {
      const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MISTRAL_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: "mistral-small-latest",
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        lastError = response.status === 429
          ? "تم تجاوز حد الطلبات على Mistral، سيتم إعادة المحاولة تلقائيًا"
          : `فشل Mistral AI [${response.status}]: ${text}`;

        if ([408, 429, 500, 502, 503, 504].includes(response.status) && attempt < MAX_MISTRAL_RETRIES) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 6_000 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(lastError);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("لم يُرجع Mistral بيانات صالحة");

      const parsed = JSON.parse(cleanJsonContent(content));
      const items = Array.isArray(parsed?.books) ? parsed.books : [];
      return books.map((book, index) => {
        const found = items.find((item: any) => Number(item.index) === index) || items[index];
        return normalizeMeta(found, book.title);
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
      if (attempt < MAX_MISTRAL_RETRIES) {
        await wait(5_000 * Math.pow(2, attempt));
        continue;
      }
    }
  }

  throw new Error(lastError);
}

async function addWatermarkIfPossible(bookFileUrl: string, extension: string): Promise<string> {
  if (!bookFileUrl || extension !== "pdf") return bookFileUrl;

  try {
    const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/add-pdf-watermark`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify({ pdfUrl: bookFileUrl, bucket: "book-files" }),
    });

    if (!response.ok) return bookFileUrl;
    const result = await response.json();
    return result?.success && result?.watermarkedUrl ? result.watermarkedUrl : bookFileUrl;
  } catch (error) {
    console.error("[AI Bulk] فشل الشعار، سيتم استخدام PDF الأصلي:", error);
    return bookFileUrl;
  }
}

async function upsertApprovedBook(book: InputBook, meta: AIBookMeta, supabaseClient: any): Promise<BookResult> {
  if (!book?.title || !book?.cover_image_url || !book?.book_file_url) {
    return { success: false, title: book?.title, error: "الحقول المطلوبة: title, cover_image_url, book_file_url" };
  }

  const title = book.title.trim();
  console.log(`[AI Bulk] معالجة: ${title}`);

  const { data: existing } = await supabaseClient
    .from("book_submissions")
    .select("id, title, book_file_url, cover_image_url")
    .eq("title", title)
    .eq("status", "approved")
    .maybeSingle();

  if (existing) {
    const needsRepair =
      !String(existing.book_file_url || "").includes("/storage/v1/object/public/book-files/") ||
      !String(existing.cover_image_url || "").includes("/storage/v1/object/public/book-covers/");

    if (!needsRepair) {
      return { success: false, duplicate: true, title, error: "كتاب موجود مسبقًا" };
    }
  }

  const [coverUrl, uploadedBook] = await Promise.all([
    downloadAndUploadImage(book.cover_image_url, supabaseClient),
    downloadAndUploadBook(book.book_file_url, supabaseClient),
  ]);

  if (!coverUrl) {
    return { success: false, title, error: "فشل رفع الغلاف إلى Supabase Storage" };
  }
  if (!uploadedBook.url) {
    return { success: false, title, error: "فشل رفع ملف الكتاب إلى Supabase Storage" };
  }

  const bookFileUrl = await addWatermarkIfPossible(uploadedBook.url, uploadedBook.extension);
  const slug = existing ? undefined : generateSlug(title);

  const payload = {
    title,
    cover_image_url: coverUrl,
    book_file_url: bookFileUrl,
    author: meta.author,
    category: meta.category,
    description: meta.description,
    language: meta.language,
    publication_year: meta.publication_year ?? null,
    page_count: meta.page_count ?? null,
    publisher: meta.publisher ?? null,
    subtitle: meta.subtitle ?? null,
    author_bio: meta.author_bio ?? null,
    display_type: "download_read",
    file_type: uploadedBook.contentType || "application/pdf",
    file_size: uploadedBook.fileSize,
    book_file_type: uploadedBook.extension || "pdf",
    status: "approved",
    user_email: book.user_email ?? "ai-bulk@kotobi.local",
    processing_status: "completed",
    rights_confirmation: true,
    reviewed_at: new Date().toISOString(),
    reviewer_notes: "تم نشره مباشرة بواسطة الرفع المجمع 2 عبر Mistral AI",
    ...(slug ? { slug } : {}),
  };

  if (existing) {
    const { data: updated, error } = await supabaseClient
      .from("book_submissions")
      .update(payload)
      .eq("id", existing.id)
      .select("id, title")
      .single();

    if (error) return { success: false, title, error: `فشل تحديث الكتاب: ${error.message}` };
    return {
      success: true,
      id: updated?.id,
      title,
      cover_image_url: coverUrl,
      book_file_url: bookFileUrl,
      cover_uploaded_to_supabase: true,
      book_uploaded_to_supabase: true,
    };
  }

  const { data: inserted, error } = await supabaseClient
    .from("book_submissions")
    .insert(payload)
    .select("id, title")
    .single();

  if (error) return { success: false, title, error: `فشل الإدراج: ${error.message}` };

  return {
    success: true,
    id: inserted?.id,
    title,
    cover_image_url: coverUrl,
    book_file_url: bookFileUrl,
    cover_uploaded_to_supabase: true,
    book_uploaded_to_supabase: true,
  };
}

async function processBooks(books: InputBook[], supabaseClient: any): Promise<BookResult[]> {
  const results: BookResult[] = [];

  for (let start = 0; start < books.length; start += MISTRAL_BATCH_SIZE) {
    const batch = books.slice(start, start + MISTRAL_BATCH_SIZE);

    let metas: AIBookMeta[];
    try {
      metas = await inferBooksMetadata(batch);
    } catch (error) {
      const message = error instanceof Error ? error.message : "فشل Mistral AI";
      results.push(
        ...batch.map((book) => ({ success: false, retryable: true, title: book.title, error: message })),
      );
      continue;
    }

    for (let i = 0; i < batch.length; i++) {
      try {
        results.push(await upsertApprovedBook(batch[i], metas[i], supabaseClient));
      } catch (error) {
        results.push({
          success: false,
          title: batch[i].title,
          error: error instanceof Error ? error.message : "خطأ غير معروف",
        });
      }
    }

    if (start + MISTRAL_BATCH_SIZE < books.length) await wait(1_500);
  }

  return results;
}

async function repairRecentAiBooks(supabaseClient: any): Promise<BookResult[]> {
  const { data: rows, error } = await supabaseClient
    .from("book_submissions")
    .select("title, cover_image_url, book_file_url, user_email")
    .eq("status", "approved")
    .eq("user_email", "ai-bulk@kotobi.local")
    .or("book_file_url.not.like.%/storage/v1/object/public/book-files/%,cover_image_url.not.like.%/storage/v1/object/public/book-covers/%")
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) throw new Error(error.message);
  if (!rows?.length) return [];
  return processBooks(rows as InputBook[], supabaseClient);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const body = await req.json();

    if (body?.repairRecentAiBooks) {
      const results = await repairRecentAiBooks(supabaseClient);
      return jsonResponse({
        success: true,
        summary: {
          total: results.length,
          success: results.filter((r) => r.success).length,
          failed: results.filter((r) => !r.success && !r.duplicate).length,
          duplicates: results.filter((r) => r.duplicate).length,
        },
        results,
      });
    }

    const books: InputBook[] = Array.isArray(body?.books)
      ? body.books
      : body?.book
        ? [body.book]
        : [];

    if (!books.length) {
      return jsonResponse({ success: false, error: "أرسل { book } أو { books: [...] }" }, 400);
    }

    const sanitized = books
      .map((book) => ({
        title: String(book.title || "").trim(),
        cover_image_url: String(book.cover_image_url || "").trim(),
        book_file_url: String(book.book_file_url || "").trim(),
        user_email: book.user_email,
      }))
      .filter((book) => book.title && book.cover_image_url && book.book_file_url);

    if (!sanitized.length) {
      return jsonResponse({ success: false, error: "لا توجد كتب صالحة للمعالجة" }, 400);
    }

    const results = await processBooks(sanitized, supabaseClient);
    const summary = {
      total: results.length,
      success: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success && !r.duplicate).length,
      duplicates: results.filter((r) => r.duplicate).length,
      retryable: results.filter((r) => r.retryable).length,
    };

    return jsonResponse({ success: true, summary, results, retry_after_ms: summary.retryable ? 30_000 : 0 });
  } catch (err) {
    console.error("[AI Bulk] خطأ:", err);
    return jsonResponse({
      success: false,
      error: err instanceof Error ? err.message : "خطأ غير معروف",
    }, 500);
  }
});
