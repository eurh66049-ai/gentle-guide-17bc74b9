import React, { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { Upload, Download, Sparkles, FileText, Plus, Trash2, Play, Pause, X, CheckCircle, AlertTriangle } from 'lucide-react';
import Papa from 'papaparse';

interface SimpleBook {
  title: string;
  cover_image_url: string;
  book_file_url: string;
}

interface BulkBookUploaderAIProps {
  onUploadComplete: () => void;
}

const SAMPLE_CSV = `title,cover_image_url,book_file_url
البخلاء,https://example.com/covers/al-bukhala.jpg,https://example.com/pdfs/al-bukhala.pdf
كليلة ودمنة,https://example.com/covers/kalila.jpg,https://example.com/pdfs/kalila.pdf`;

const AI_BATCH_SIZE = 1;
const BETWEEN_BATCH_DELAY_MS = 7000;
const RETRY_DELAY_MS = 30000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface UploadBookResult {
  success?: boolean;
  duplicate?: boolean;
  retryable?: boolean;
  error?: string;
  title?: string;
}

const BulkBookUploaderAI: React.FC<BulkBookUploaderAIProps> = ({ onUploadComplete }) => {
  const [books, setBooks] = useState<SimpleBook[]>([]);
  const [manualRows, setManualRows] = useState<SimpleBook[]>([
    { title: '', cover_image_url: '', book_file_url: '' },
  ]);
  const [uploading, setUploading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentTitle, setCurrentTitle] = useState('');
  const [results, setResults] = useState({ success: 0, failed: 0, duplicates: 0, errors: [] as string[] });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pauseRef = useRef(false);
  const cancelRef = useRef(false);
  const { toast } = useToast();

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sample-books-ai.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCsvFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      encoding: 'UTF-8',
      complete: (res) => {
        const rows = (res.data as Partial<SimpleBook>[])
          .map((r) => ({
            title: (r.title || '').trim(),
            cover_image_url: (r.cover_image_url || '').trim(),
            book_file_url: (r.book_file_url || '').trim(),
          }))
          .filter((r) => r.title && r.cover_image_url && r.book_file_url);
        setBooks(rows);
        toast({
          title: 'تم تحميل الملف',
          description: `تم العثور على ${rows.length} كتاب صالح`,
        });
      },
      error: (err) => {
        toast({ title: 'خطأ في قراءة الملف', description: err.message, variant: 'destructive' });
      },
    });
  };

  const addManualRow = () => {
    setManualRows((prev) => [...prev, { title: '', cover_image_url: '', book_file_url: '' }]);
  };

  const removeManualRow = (idx: number) => {
    setManualRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateManualRow = (idx: number, field: keyof SimpleBook, val: string) => {
    setManualRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: val } : r)));
  };

  const useManualRows = () => {
    const valid = manualRows.filter(
      (r) => r.title.trim() && r.cover_image_url.trim() && r.book_file_url.trim(),
    );
    if (valid.length === 0) {
      toast({ title: 'لا توجد بيانات', description: 'املأ صفًا واحدًا على الأقل', variant: 'destructive' });
      return;
    }
    setBooks(valid);
    toast({ title: 'تم تجهيز الكتب', description: `${valid.length} كتاب جاهز للرفع` });
  };

  const uploadBatch = async (batch: SimpleBook[]): Promise<UploadBookResult[]> => {
    const { data, error } = await supabase.functions.invoke('bulk-upload-books-ai', {
      body: { books: batch },
    });

    if (error) {
      return batch.map((book) => ({
        success: false,
        retryable: true,
        title: book.title,
        error: error.message || 'تعذر الاتصال بدالة الرفع',
      }));
    }

    if (Array.isArray(data?.results)) return data.results;

    if (data?.success && data?.book) {
      return [{ success: true, title: data.book.title }];
    }

    return batch.map((book) => ({
      success: false,
      title: book.title,
      error: data?.error || 'خطأ غير معروف',
    }));
  };

  const startUpload = async () => {
    if (books.length === 0) {
      toast({ title: 'لا توجد كتب', description: 'حمّل ملف CSV أو أضف صفوفًا أولًا', variant: 'destructive' });
      return;
    }
    setUploading(true);
    setPaused(false);
    pauseRef.current = false;
    cancelRef.current = false;
    setCurrentIndex(0);
    setResults({ success: 0, failed: 0, duplicates: 0, errors: [] });

    const localResults = { success: 0, failed: 0, duplicates: 0, errors: [] as string[] };
    let pending = books;
    let attempt = 0;
    let processed = 0;

    while (pending.length > 0 && attempt < 4 && !cancelRef.current) {
      const retryableBooks: SimpleBook[] = [];
      attempt += 1;

      for (let start = 0; start < pending.length; start += AI_BATCH_SIZE) {
        if (cancelRef.current) break;
        while (pauseRef.current && !cancelRef.current) {
          await delay(400);
        }
        if (cancelRef.current) break;

        const batch = pending.slice(start, start + AI_BATCH_SIZE);
        setCurrentIndex(Math.min(processed, books.length - 1));
        setCurrentTitle(`دفعة ${Math.floor(start / AI_BATCH_SIZE) + 1} — ${batch.map((b) => b.title).join('، ')}`);

        const batchResults = await uploadBatch(batch);
        batchResults.forEach((result, index) => {
          const book = batch[index] || batch.find((b) => b.title === result.title) || batch[0];

          if (result.success) {
            localResults.success += 1;
            processed += 1;
          } else if (result.duplicate) {
            localResults.duplicates += 1;
            processed += 1;
          } else if (result.retryable && attempt < 4) {
            retryableBooks.push(book);
          } else {
            localResults.failed += 1;
            processed += 1;
            localResults.errors.push(`${book.title}: ${result.error || 'فشل غير معروف'}`);
          }
        });

        setResults({ ...localResults });
        await delay(BETWEEN_BATCH_DELAY_MS);
      }

      pending = retryableBooks;
      if (pending.length > 0 && attempt < 4 && !cancelRef.current) {
        setCurrentTitle(`انتظار ${RETRY_DELAY_MS / 1000} ثانية ثم إعادة محاولة ${pending.length} كتاب بسبب حد Mistral`);
        await delay(RETRY_DELAY_MS);
      }
    }

    if (pending.length > 0 && !cancelRef.current) {
      localResults.failed += pending.length;
      localResults.errors.push(...pending.map((book) => `${book.title}: تعذر الرفع بعد عدة محاولات، أعد تشغيل الرفع لاحقًا`));
      setResults({ ...localResults });
    }

    setUploading(false);
    setCurrentTitle('');
    onUploadComplete();
    toast({
      title: cancelRef.current ? 'تم الإيقاف' : 'اكتمل الرفع',
      description: 'انتهت عملية الرفع المجمع بمساعدة الذكاء الاصطناعي',
    });
  };

  const togglePause = () => {
    pauseRef.current = !pauseRef.current;
    setPaused(pauseRef.current);
  };

  const cancelUpload = () => {
    cancelRef.current = true;
    pauseRef.current = false;
    setPaused(false);
  };

  const progress = books.length > 0 ? ((currentIndex + (uploading ? 0 : 1)) / books.length) * 100 : 0;
  const totalProcessed = results.success + results.failed + results.duplicates;

  return (
    <div className="space-y-6" dir="rtl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            رفع مجمع 2 — بمساعدة الذكاء الاصطناعي
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <Sparkles className="h-4 w-4" />
            <AlertDescription>
              ارفع ملف CSV يحتوي على ثلاثة حقول فقط: <strong>title</strong>،{' '}
              <strong>cover_image_url</strong>، <strong>book_file_url</strong>. الذكاء الاصطناعي
              سيستنتج المؤلف، التصنيف، الوصف، اللغة، عدد الصفحات وسنة النشر تلقائيًا، ثم يرفع الغلاف
              وملف PDF إلى Supabase وينشر الكتب مباشرة في الموقع.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={downloadSample}>
              <Download className="ml-2 h-4 w-4" />
              تحميل ملف نموذجي
            </Button>
            <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              <FileText className="ml-2 h-4 w-4" />
              اختيار ملف CSV
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleCsvFile}
            />
            {books.length > 0 && (
              <Badge variant="secondary" className="text-base px-3 py-1">
                {books.length} كتاب جاهز
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">أو أضف الكتب يدويًا</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {manualRows.map((row, idx) => (
            <div key={idx} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
              <div>
                <Label className="text-xs">عنوان الكتاب</Label>
                <Input
                  value={row.title}
                  onChange={(e) => updateManualRow(idx, 'title', e.target.value)}
                  placeholder="البخلاء"
                  disabled={uploading}
                />
              </div>
              <div>
                <Label className="text-xs">رابط الغلاف</Label>
                <Input
                  value={row.cover_image_url}
                  onChange={(e) => updateManualRow(idx, 'cover_image_url', e.target.value)}
                  placeholder="https://..."
                  disabled={uploading}
                />
              </div>
              <div>
                <Label className="text-xs">رابط التحميل (PDF)</Label>
                <Input
                  value={row.book_file_url}
                  onChange={(e) => updateManualRow(idx, 'book_file_url', e.target.value)}
                  placeholder="https://..."
                  disabled={uploading}
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeManualRow(idx)}
                disabled={uploading || manualRows.length === 1}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button variant="outline" onClick={addManualRow} disabled={uploading}>
              <Plus className="ml-2 h-4 w-4" />
              إضافة صف
            </Button>
            <Button variant="secondary" onClick={useManualRows} disabled={uploading}>
              تجهيز هذه الصفوف للرفع
            </Button>
          </div>
        </CardContent>
      </Card>

      {books.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">بدء الرفع</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!uploading ? (
              <Button onClick={startUpload} className="w-full" size="lg">
                <Upload className="ml-2 h-5 w-5" />
                ابدأ رفع {books.length} كتاب عبر Mistral AI
              </Button>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>
                      جارِ المعالجة: {currentIndex + 1} / {books.length}
                    </span>
                    <span className="text-muted-foreground truncate max-w-[60%]">{currentTitle}</span>
                  </div>
                  <Progress value={progress} />
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={togglePause} className="flex-1">
                    {paused ? <Play className="ml-2 h-4 w-4" /> : <Pause className="ml-2 h-4 w-4" />}
                    {paused ? 'متابعة' : 'إيقاف مؤقت'}
                  </Button>
                  <Button variant="destructive" onClick={cancelUpload} className="flex-1">
                    <X className="ml-2 h-4 w-4" />
                    إلغاء
                  </Button>
                </div>
              </>
            )}

            {totalProcessed > 0 && (
              <div className="grid grid-cols-3 gap-3 pt-2">
                <div className="rounded-lg border p-3 text-center">
                  <CheckCircle className="h-5 w-5 mx-auto text-green-600 mb-1" />
                  <div className="text-2xl font-bold">{results.success}</div>
                  <div className="text-xs text-muted-foreground">نجح</div>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <AlertTriangle className="h-5 w-5 mx-auto text-amber-600 mb-1" />
                  <div className="text-2xl font-bold">{results.duplicates}</div>
                  <div className="text-xs text-muted-foreground">مكرر</div>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <X className="h-5 w-5 mx-auto text-red-600 mb-1" />
                  <div className="text-2xl font-bold">{results.failed}</div>
                  <div className="text-xs text-muted-foreground">فشل</div>
                </div>
              </div>
            )}

            {results.errors.length > 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <div className="font-semibold mb-1">آخر الأخطاء:</div>
                  <ul className="text-xs space-y-1 max-h-40 overflow-auto">
                    {results.errors.slice(-10).map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default BulkBookUploaderAI;
