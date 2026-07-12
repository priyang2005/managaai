import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Support up to 20mb payload for large CSV file contents
  app.use(express.json({ limit: "20mb" }));
  app.use(express.urlencoded({ limit: "20mb", extended: true }));

  // Lazy initialize Gemini client so the app doesn't crash if the key is missing
  const getGeminiClient = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return null;
    }
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  };

  // API endpoint for checking configuration
  app.get("/api/config", (req, res) => {
    res.json({
      hasApiKey: !!process.env.GEMINI_API_KEY,
    });
  });

  // API endpoint for workload and pattern analysis
  app.post("/api/analyze", async (req, res) => {
    try {
      const ai = getGeminiClient();
      if (!ai) {
        return res.status(400).json({
          error: "GEMINI_API_KEY environment variable is required. Please set it in Settings > Secrets.",
        });
      }

      const { csvRaw, csvParsed, problemDescription } = req.body;

      if (!csvRaw && (!csvParsed || csvParsed.length === 0)) {
        return res.status(400).json({ error: "Please provide CSV work data to analyze." });
      }

      const dataSnippet = csvParsed 
        ? JSON.stringify(csvParsed.slice(0, 500)) 
        : (typeof csvRaw === "string" ? csvRaw.substring(0, 30000) : JSON.stringify(csvRaw));

      const prompt = `
You are analyzing team work patterns, task tracking logs, and productivity metrics to discover team bottlenecks, workload imbalances, and efficiency metrics.

Here is the task/workflow data uploaded by the project manager:
${dataSnippet}

The project manager describes the following problem or primary concern to investigate:
"${problemDescription || "Analyze the overall team workflow, identify major bottlenecks, workload distribution issues, and supply actionable strategic recommendations."}"

Analyze the dataset and the problem details. Run computations of:
1. Average resolution times per phase or task type.
2. Task workload per team member (Assigned, Completed, Overtime/Delay hours).
3. Bottlenecks (High/Medium/Low impact) with responsible teams or areas.
4. Strategic, highly actionable recommendations for the project manager to solve the issues.
5. Overall team productivity score (0-100) based on completion rates and delay ratios.
6. A trend score representing progress or change across different weeks.

You must reply with a single JSON object matching the requested schema. Make sure the 'summary' field is a comprehensive markdown report.
`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          systemInstruction: "You are an elite productivity analysis AI. You analyze task data, logs, and work patterns to identify specific bottlenecks, workload imbalances, and provide actionable project management recommendations. You MUST output a JSON object adhering exactly to the requested schema. Ensure the 'summary' field is rich and detailed with markdown format.",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
                description: "Deep, detailed markdown analysis of work patterns, findings, bottlenecks, and executive summary.",
              },
              productivityScore: {
                type: Type.INTEGER,
                description: "Overall team productivity score (0-100) calculated from the data.",
              },
              bottlenecks: {
                type: Type.ARRAY,
                description: "List of identified bottlenecks in team operations.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    impact: { type: Type.STRING, description: "High, Medium, or Low" },
                    ownerOrTeam: { type: Type.STRING, description: "Responsible person or team/department" },
                  },
                  required: ["title", "description", "impact", "ownerOrTeam"],
                },
              },
              recommendations: {
                type: Type.ARRAY,
                description: "Strategic project manager recommendations.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    steps: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    priority: { type: Type.STRING, description: "High, Medium, or Low" },
                    impactDescription: { type: Type.STRING },
                  },
                  required: ["title", "steps", "priority", "impactDescription"],
                },
              },
              charts: {
                type: Type.OBJECT,
                properties: {
                  workloadDistribution: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING, description: "Person or Team name" },
                        assigned: { type: Type.INTEGER },
                        completed: { type: Type.INTEGER },
                        overtimeHours: { type: Type.INTEGER },
                      },
                      required: ["name", "assigned", "completed"],
                    },
                  },
                  timelineEfficiency: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        phase: { type: Type.STRING, description: "Phase/Task Type e.g. Development, Code Review, QA" },
                        averageTimeDays: { type: Type.NUMBER },
                        targetTimeDays: { type: Type.NUMBER },
                      },
                      required: ["phase", "averageTimeDays", "targetTimeDays"],
                    },
                  },
                  weeklyTrend: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        week: { type: Type.STRING, description: "e.g. Week 1, Week 2" },
                        score: { type: Type.INTEGER },
                      },
                      required: ["week", "score"],
                    },
                  },
                },
                required: ["workloadDistribution", "timelineEfficiency", "weeklyTrend"],
              },
            },
            required: ["summary", "productivityScore", "bottlenecks", "recommendations", "charts"],
          },
        },
      });

      const responseText = response.text;
      if (!responseText) {
        throw new Error("Empty response received from Gemini API");
      }

      const result = JSON.parse(responseText.trim());
      res.json(result);
    } catch (error: any) {
      console.error("Analysis error:", error);
      res.status(500).json({ error: error?.message || "An error occurred during analysis." });
    }
  });

  // Serve static assets in production, otherwise mount Vite server middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
