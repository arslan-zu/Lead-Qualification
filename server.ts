import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Increase limit to handle bulk CSV metadata uploads/downloads
app.use(express.json({ limit: "50mb" }));

// Initialize Gemini Client with correct visual user agent header for telemetry
const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing. Please add it in Settings > Secrets to enable classification.");
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

// Raw Scraper helper using standard fetch
async function scrapeUrlContent(url: string): Promise<{
  success: boolean;
  title: string;
  description: string;
  cleanedText: string;
  error?: string;
}> {
  try {
    let target = url.trim();
    if (!target) {
      return { success: false, title: "", description: "", cleanedText: "No website URL provided" };
    }
    // Prepend Protocol if missing
    if (!/^https?:\/\//i.test(target)) {
      target = `https://${target}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second scrape timeout

    const res = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache"
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP status ${res.status} ${res.statusText}`);
    }

    const html = await res.text();

    // Regex parsing for title & meta description (lightweight, stable, CORS handled)
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "";

    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i) || 
                      html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i);
    const description = descMatch ? descMatch[1].trim() : "";

    // Text extraction: purge scripts, styles, iframe, svgs, then strip tags
    let text = html
      .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, "")
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, "")
      .replace(/<svg[^>]*>([\s\S]*?)<\/svg>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length > 12000) {
      text = text.substring(0, 12000) + "...";
    }

    return {
      success: true,
      title,
      description,
      cleanedText: text || "HTML page fetched but empty of main text body"
    };
  } catch (err: any) {
    return {
      success: false,
      title: "",
      description: "",
      cleanedText: "",
      error: err.message || String(err)
    };
  }
}

// -------------------------------------------------------------
// REST API routes
// -------------------------------------------------------------

// API health and configuration diagnostic
app.get("/api/config", (req, res) => {
  res.json({
    geminiKeyConfigured: !!process.env.GEMINI_API_KEY,
    appUrl: process.env.APP_URL || "http://localhost:3000"
  });
});

// Primary Enrichment & Classification Endpoint
app.post("/api/classify", async (req, res) => {
  try {
    const { companyName, url, customFields, customInstructions } = req.body;

    if (!companyName && !url) {
      res.status(400).json({ error: "Missing required parameters: companyName or url is required." });
      return;
    }

    const ai = getGeminiClient();

    // Step 1: Attempt to scrape the website
    let scrapedData: { success: boolean; title: string; description: string; cleanedText: string; error?: string } = { success: false, title: "", description: "", cleanedText: "", error: "Not attempted" };
    if (url) {
      scrapedData = await scrapeUrlContent(url);
    }

    // Step 2: Build the classification request prompt
    let inputContext = `Company Name: ${companyName || "Unknown"}\n`;
    if (url) inputContext += `Website URL: ${url}\n`;
    
    if (scrapedData.success) {
      inputContext += `\nDirectly Scraped Site Metadata:\n`;
      inputContext += `- Home Title: "${scrapedData.title}"\n`;
      inputContext += `- Meta Description: "${scrapedData.description}"\n`;
      inputContext += `\nRaw Sample Content extracted from Home Page:\n${scrapedData.cleanedText}\n`;
    } else {
      inputContext += `\nNote: Direct HTML Scraping failed with error: "${scrapedData.error || "No URL Specified"}"\n`;
      inputContext += `Please use Google Search grounding extensively to lookup and research this company's true current product and site domain.\n`;
    }

    let customEnrichmentPrompt = "";
    if (customFields && Array.isArray(customFields) && customFields.length > 0) {
      customEnrichmentPrompt = "\nYou MUST enrich the company with these specific custom fields. Match the keys exactly as requested:\n";
      customFields.forEach((field: { name: string; prompt: string }, index: number) => {
        customEnrichmentPrompt += `${index + 1}. Key name: "${field.name}" | Rule: ${field.prompt}\n`;
      });
    }

    const systemInstruction = 
      "You are a meticulous B2B market researcher and company classification intelligence system.\n" +
      "Your goal is to lookup or inspect the given company named, analyze their primary business value, industry, audience, products, and tech profile.\n" +
      "Use Google Search grounding to supplement and correct any scraped text, ensuring you accurately find the real website or real company if specified.\n" +
      "Ensure all JSON property matches strictly. Do not hallucinate fields.\n" +
      (customInstructions ? `\nFollow these specific user rules:\n${customInstructions}` : "");

    const fullPrompt = 
      `Analyze the following corporate entity details and respond with a structured JSON object according to the schema:\n\n` +
      `[Subject Profile]\n` +
      `${inputContext}\n` +
      `${customEnrichmentPrompt}\n` +
      `Instructions for customFields array:\n` +
      `- If custom fields were specified above, you MUST populate the "customFields" array with items containing:` +
      `  "columnName" (matching exact Key name provided) and "value" (the enriched valuation).\n` +
      `- If no custom fields are specified, leave it as an empty array.\n\n` +
      `Provide high fidelity categorisations. Make your best estimates if certain fields are hard to determine.`;

    // Step 3: Call Gemini with Google Search tool and structured Response Schema
    const geminiOptions: any = {
      model: "gemini-3.5-flash",
      contents: fullPrompt,
      config: {
        systemInstruction,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            companyName: { 
              type: Type.STRING, 
              description: "The verified company name. Clean any legal prefixes or suffixes unless necessary." 
            },
            url: { 
              type: Type.STRING, 
              description: "The verified or corrected website URL." 
            },
            industry: { 
              type: Type.STRING, 
              description: "A standard high-level industry e.g., SaaS, E-commerce, FinTech, Healthcare, Cybersecurity, Logistics, Education, Web3, Real Estate, Professional Services, etc." 
            },
            subIndustry: { 
              type: Type.STRING, 
              description: "A more granular description or niche sector (e.g. AI-Powered Sales Outreach, API security, Headless commerce)." 
            },
            description: { 
              type: Type.STRING, 
              description: "A clean, executive 1-sentence value proposition of what this company does." 
            },
            stageOrSize: { 
              type: Type.STRING, 
              description: "Estimated size/stage category: Bootstrap, Venture Backed, Growth Stage, Enterprise, Public, or Small Business." 
            },
            targetAudience: { 
              type: Type.STRING, 
              description: "Who they serve primarily: B2B, B2C, Developer-Focused, Freelancers, or Enterprise." 
            },
            mainProduct: { 
              type: Type.STRING, 
              description: "The name of their flagship product or key offering." 
            },
            techStackTags: { 
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "Estimate 3-6 technologies, platforms, or tools they likely use or integrate with (e.g. Stripe, AWS, HubSpot, NextJS, Shopify, PostgreSQL)." 
            },
            pricingModel: { 
              type: Type.STRING, 
              description: "Estimated pricing model: SaaS (Subscription), Usage-Based/Transactional, Enterprise Contract, Free/Freemium, or E-Commerce Retail." 
            },
            confidenceScore: { 
              type: Type.NUMBER, 
              description: "Numerical confidence score between 0.00 and 1.00 estimating your output accuracy based on source quality." 
            },
            customFields: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  columnName: { type: Type.STRING },
                  value: { type: Type.STRING }
                },
                required: ["columnName", "value"]
              },
              description: "Dynamic array matching the custom fields requested."
            }
          },
          required: [
            "companyName", "url", "industry", "subIndustry", "description", 
            "stageOrSize", "targetAudience", "mainProduct", "techStackTags", 
            "pricingModel", "confidenceScore", "customFields"
          ]
        }
      }
    };

    const response = await ai.models.generateContent(geminiOptions);
    const resultText = response.text;

    if (!resultText) {
      throw new Error("Empty response returned from Gemini API.");
    }

    const cleanJson = JSON.parse(resultText.trim());

    res.json({
      success: true,
      data: cleanJson,
      scrapeReport: {
        attempted: !!url,
        directScrapeOk: scrapedData.success,
        directTitle: scrapedData.title,
        directError: scrapedData.error || null,
      }
    });

  } catch (error: any) {
    console.error("Error classifying company:", error);
    res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

// -------------------------------------------------------------
// Vite Frontend Server Setup
// -------------------------------------------------------------
async function startServer() {
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
    console.log(`Site Classifier fullstack server active on: http://localhost:${PORT}`);
  });
}

startServer();
