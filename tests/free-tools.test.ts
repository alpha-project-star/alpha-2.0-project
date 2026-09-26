import { describe, it, expect, vi } from "vitest";
import { evaluateMathExpression } from "../src/lib/tools/math-sandbox";
import { fetchWeather } from "../src/lib/tools/weather";
import { lookupWikipedia, lookupArxiv } from "../src/lib/tools/knowledge";
import { executeTool } from "../src/lib/alpha.functions";

describe("Free Tool Subsystem (Weather, Knowledge, Math Sandbox)", () => {
  describe("Math Sandbox (evaluateMathExpression)", () => {
    it("evaluates basic arithmetic and exponents correctly", () => {
      const res = evaluateMathExpression("2^10 + 5 * 4");
      expect(res.success).toBe(true);
      expect(res.result).toBe(1044);
      expect(res.formatted).toBe("1044");
    });

    it("evaluates trigonometric, square root, and constant functions", () => {
      const res = evaluateMathExpression("sqrt(144) + sin(pi / 2)");
      expect(res.success).toBe(true);
      expect(res.result).toBe(13);
    });

    it("evaluates compound interest formulas correctly", () => {
      const res = evaluateMathExpression("1000 * (1 + 0.05)^2");
      expect(res.success).toBe(true);
      expect(Number(res.result)).toBeCloseTo(1102.5);
    });

    it("rejects malicious tokens and globals", () => {
      const res = evaluateMathExpression("process.exit()");
      expect(res.success).toBe(false);
      expect(res.error).toContain("Forbidden token detected");
    });

    it("handles empty or malformed expressions gracefully", () => {
      const res = evaluateMathExpression("+++");
      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
    });
  });

  describe("Weather Tool (fetchWeather)", () => {
    it("parses weather response structure safely", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
        if (String(url).includes("geocoding-api.open-meteo.com")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              results: [
                {
                  name: "Tokyo",
                  admin1: "Tokyo",
                  country: "Japan",
                  latitude: 35.6895,
                  longitude: 139.6917,
                },
              ],
            }),
          } as any;
        }
        if (String(url).includes("api.open-meteo.com/v1/forecast")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              current: {
                temperature_2m: 22.5,
                weather_code: 0,
                wind_speed_10m: 5.2,
                relative_humidity_2m: 45,
              },
              current_units: {
                temperature_2m: "°C",
              },
              daily: {
                time: ["2026-09-25", "2026-09-26"],
                temperature_2m_max: [24.0, 23.0],
                temperature_2m_min: [18.0, 17.5],
                precipitation_probability_max: [10, 20],
                weather_code: [0, 1],
              },
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      });

      const res = await fetchWeather("Tokyo");
      expect(res.success).toBe(true);
      expect(res.location).toContain("Tokyo");
      expect(res.current?.temperature).toBe(22.5);
      expect(res.current?.weatherDescription).toBe("Clear sky");
      expect(res.daily?.length).toBe(2);

      vi.restoreAllMocks();
    });
  });

  describe("Knowledge Tool (lookupWikipedia & lookupArxiv)", () => {
    it("fetches Wikipedia summary correctly", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          title: "Quantum computing",
          extract: "Quantum computing is a rapidly-emerging technology.",
          content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Quantum_computing" } },
        }),
      } as any);

      const res = await lookupWikipedia("Quantum computing");
      expect(res.success).toBe(true);
      expect(res.source).toBe("wikipedia");
      expect(res.title).toBe("Quantum computing");
      expect(res.summary).toContain("rapidly-emerging technology");

      vi.restoreAllMocks();
    });

    it("parses arXiv atom feed correctly", async () => {
      const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/2601.12345v1</id>
          <title>Advances in Transformer Architectures</title>
          <summary>We present a novel self-attention mechanism.</summary>
          <published>2026-01-15T00:00:00Z</published>
        </entry>
      </feed>`;

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => mockXml,
      } as any);

      const res = await lookupArxiv("transformer architecture");
      expect(res.success).toBe(true);
      expect(res.source).toBe("arxiv");
      expect(res.results?.length).toBe(1);
      expect(res.results?.[0].title).toContain("Advances in Transformer Architectures");

      vi.restoreAllMocks();
    });
  });

  describe("executeTool Dispatch Integration", () => {
    it("dispatches evaluateMath through executeTool", async () => {
      const result = await executeTool(
        {
          function: {
            name: "evaluateMath",
            arguments: JSON.stringify({ expression: "sqrt(256) * 2" }),
          },
        },
        { userId: "test_user" }
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe(32);
    });
  });
});
