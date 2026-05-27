import { NextResponse } from "next/server";

export async function GET() {
  let keepAlive: NodeJS.Timeout | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`));
      keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(`: keep-alive\n\n`));
      }, 15000);
    },
    cancel() {
      if (keepAlive) clearInterval(keepAlive);
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
