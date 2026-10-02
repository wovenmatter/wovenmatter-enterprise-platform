import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Download } from "lucide-react";
import { ErrorNotice, Loading, PageHeader } from "../components/ui";
import { errorMessage } from "../api";
import { useWorkspace } from "../workspace";
import {
  boundedBytes,
  filenameFromDisposition,
  PreviewTooLarge,
  previewType,
} from "../source-preview";

type Preview = {
  filename: string;
  kind: "pdf" | "image" | "text" | "unsupported" | "large";
  url?: string;
  text?: string;
  message?: string;
};
export function SourcePage() {
  const { orgBase } = useWorkspace();
  const { fileId } = useParams();
  const [query] = useSearchParams();
  const projectId = query.get("projectId");
  const versionId = query.get("versionId");
  const pageValue = Number(query.get("page"));
  const page =
    Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : undefined;
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (versionId) params.set("versionId", versionId);
  const contentUrl = `/enterprise/api/files/${encodeURIComponent(fileId ?? "")}/content${params.size ? `?${params}` : ""}`;
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setPreview(undefined);
    setError("");
    setLoading(true);
    async function load() {
      let filename = "Document";
      let limit = 0;
      try {
        const response = await fetch(contentUrl, {
          credentials: "same-origin",
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          if (response.status === 401)
            window.dispatchEvent(new Event("session-expired"));
          const body = await response.json().catch(() => null);
          throw new Error(
            body?.error?.message ??
              `The document could not be opened (${response.status}).`,
          );
        }
        filename = filenameFromDisposition(
          response.headers.get("content-disposition"),
        );
        const type = previewType(filename);
        limit = type.limit;
        if (type.kind === "unsupported") {
          await response.body?.cancel();
          if (!controller.signal.aborted)
            setPreview({
              filename,
              kind: "unsupported",
              message:
                "Download the original file to open it in its application.",
            });
          return;
        }
        const bytes = await boundedBytes(response, type.limit);
        if (controller.signal.aborted) return;
        if (type.kind === "text") {
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            setPreview({
              filename,
              kind: "unsupported",
              message:
                "This file is not UTF-8 text. Download the original to open it.",
            });
            return;
          }
          setPreview({ filename, kind: "text", text });
          return;
        }
        if (
          type.kind === "pdf" &&
          new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
        ) {
          setPreview({
            filename,
            kind: "unsupported",
            message:
              "This file does not have a valid PDF header. Download the original to inspect it.",
          });
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: type.mimeType }),
        );
        setPreview({ filename, kind: type.kind, url: objectUrl });
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof PreviewTooLarge)
          setPreview({
            filename,
            kind: "large",
            message: `This file exceeds the ${limit / (1024 * 1024)} MB browser preview limit. Download the original file to open it.`,
          });
        else setError(errorMessage(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [contentUrl]);
  return (
    <section className="source-page">
      <Link
        className="breadcrumb"
        to={
          projectId
            ? `${orgBase}/projects/${encodeURIComponent(projectId)}/files`
            : `${orgBase}/library`
        }
      >
        <ArrowLeft size={15} />
        Back to files
      </Link>
      <PageHeader
        title={preview?.filename ?? "Document"}
        description={`${versionId ? "Saved document version" : "Current document"}${page ? ` · Page ${page}` : ""}`}
        actions={
          <a className="primary button-link" href={contentUrl} download>
            <Download size={16} />
            Download original
          </a>
        }
      />
      <ErrorNotice message={error} />
      {loading ? (
        <Loading />
      ) : preview?.kind === "pdf" ? (
        <iframe
          className="pdf-preview"
          title={`PDF preview of ${preview.filename}`}
          src={`${preview.url}${page ? `#page=${page}` : ""}`}
          referrerPolicy="no-referrer"
        />
      ) : preview?.kind === "image" ? (
        <div className="image-preview">
          <img
            src={preview.url}
            alt={preview.filename}
            onError={() =>
              setPreview((previous) =>
                previous
                  ? {
                      filename: previous.filename,
                      kind: "unsupported",
                      message:
                        "This image could not be decoded. Download the original file to open it.",
                    }
                  : previous,
              )
            }
          />
        </div>
      ) : preview?.kind === "text" ? (
        <pre className="text-preview">{preview.text}</pre>
      ) : preview ? (
        <div className="preview-fallback">
          <h2>Open the original document</h2>
          <p>{preview.message}</p>
          <a className="secondary button-link" href={contentUrl} download>
            <Download size={16} />
            Download original
          </a>
        </div>
      ) : null}
    </section>
  );
}
