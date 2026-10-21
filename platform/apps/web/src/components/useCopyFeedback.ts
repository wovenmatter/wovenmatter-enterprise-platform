import { useLayoutEffect, useRef, useState } from "react";

/** Feedback belongs to one content revision and its latest copy operation. */
export function useCopyFeedback(content: string) {
  const [feedback, setFeedback] = useState({ content, message: "" });
  const operation = useRef(0);
  useLayoutEffect(() => {
    setFeedback({ content, message: "" });
    // Invalidate completions both when content changes and on unmount.
    return () => { operation.current++; };
  }, [content]);
  async function copy(write: () => Promise<void>) {
    const request = ++operation.current;
    setFeedback({ content, message: "Copying…" });
    try {
      await write();
      if (request === operation.current)
        setFeedback({ content, message: "Copied" });
    } catch (error) {
      if (request === operation.current)
        setFeedback({ content, message: error instanceof Error ? error.message : "Copy failed" });
    }
  }
  return { copy, copyState: feedback.content === content ? feedback.message : "" };
}
