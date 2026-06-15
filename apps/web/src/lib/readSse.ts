export async function readSSE(
    response: Response,
    onMessage: (data: string) => void,
) {
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    if (!response.body) {
        throw new Error("ReadableStream is not available in this browser.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let pendingText = "";

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            pendingText += decoder.decode();
            break;
        }

        pendingText += decoder.decode(value, { stream: true });
        const parts = pendingText.split("\n\n");
        pendingText = parts.pop() ?? "";

        for (const part of parts) {
            const lines = part.split("\n");
            const dataLines: string[] = [];

            for (const line of lines) {
                if (line.startsWith("data:")) {
                    dataLines.push(line.slice(5).trimStart());
                }
            }

            if (dataLines.length > 0) {
                onMessage(dataLines.join("\n"));
            }
        }
    }

    if (pendingText.trim()) {
        const lines = pendingText.split("\n");
        const dataLines: string[] = [];

        for (const line of lines) {
            if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
            }
        }

        if (dataLines.length > 0) {
            onMessage(dataLines.join("\n"));
        }
    }
}
