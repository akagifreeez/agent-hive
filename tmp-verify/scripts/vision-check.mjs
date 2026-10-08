// ビジョン対応確認: 1x1 PNGをGLMに送って応答を確認する(使い捨てスクリプト)
import { loadConfig } from "../src/config.js";
const key = loadConfig().model.apiKey;
const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: "z-ai/glm-5.3-flash",
    max_tokens: 100,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "この画像の色を1語で答えて(白/黒/赤/青)" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png1x1}` } },
      ],
    }],
  }),
});
console.log("status:", res.status);
const data = await res.json().catch(() => null);
console.log("応答:", data?.choices?.[0]?.message?.content ?? JSON.stringify(data).slice(0, 400));
