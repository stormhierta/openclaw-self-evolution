---
name: web-search
description: "Search the web using DuckDuckGo for real-time information, current events, and fact-checking. Use when: user asks about recent news, facts requiring up-to-date information, comparing products, researching topics, or anything that requires current web data. NOT for: historical knowledge (pre-web), highly specialized academic research (use Google Scholar), or tasks better suited to specific tools (e.g., weather, calendar)."
homepage: https://duckduckgo.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🔍",
        "requires": { "bins": ["curl"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "curl",
              "bins": ["curl"],
              "label": "Install curl (brew)",
            },
          ],
      },
  }
---

# Web Search Skill

Search the web using DuckDuckGo to retrieve real-time information, current events, product comparisons, and factual data.

## When to Use

✅ **USE this skill when:**

- User asks about current news or recent events
- Factual question that requires up-to-date web data
- Comparing products, services, or options
- Researching a topic with no prior context in the conversation
- Verifying a claim or fact-checking
- Finding a website, article, or resource
- Query examples:
  - "What's the latest news on [topic]?"
  - "Is [claim] true?"
  - "What's the best [product category] right now?"
  - "How do I [task] — find a tutorial?"

❌ **DO NOT use this skill when:**

- User is asking about personal/private data (emails, calendar, messages) → use platform-specific tools
- The question is answerable from conversation context or world knowledge
- Searching for media (images, videos) → use image search or platform-specific tools
- Highly specialized academic research → suggest Google Scholar or Semantic Scholar
- Legal or medical advice → suggest consulting a professional

## Prerequisites

- Requires `curl` to be installed
- No API key required (uses DuckDuckGo's HTML interface)

## Tool Usage

### Basic Web Search

```bash
# Simple search (returns titles, URLs, snippets)
curl -s "https://duckduckgo.com/html/?q=openclaw+ai+agent"
```

### With SafeSearch

```bash
# Strict SafeSearch (filters explicit content)
curl -s "https://duckduckgo.com/html/?q=search+term&sS=strict"

# Moderate SafeSearch (default)
curl -s "https://duckduckgo.com/html/?q=search+term&sS=moderate"

# Off (no filtering)
curl -s "https://duckduckgo.com/html/?q=search+term&sS=off"
```

### Limiting Results

```bash
# Limit to top N results (10 is default, max varies)
curl -s "https://duckduckgo.com/html/?q=search+term&num=5"
```

## Query Construction Guidelines

### Be Specific and Concise
```bash
# ❌ Too vague
curl -s "https://duckduckgo.com/html/?q=apple"

# ✅ Specific
curl -s "https://duckduckgo.com/html/?q=Apple+Intelligence+2025+features"
```

### Use Quotes for Exact Phrases
```bash
curl -s "https://duckduckgo.com/html/?q=%22exact+phrase+here%22"
```

### Exclude Terms with Minus
```bash
curl -s "https://duckduckgo.com/html/?q=python+-%22python+2%22"
```

### Combine Site and Topic
```bash
curl -s "https://duckduckgo.com/html/?q=site%3Agithub.com+openclaw+plugin"
```

### Time-Sensitive Queries
For recent information, include the year or current date:
```bash
curl -s "https://duckduckgo.com/html/?q=AI+agent+news+2026"
```

## Response Template

When presenting search results to the user, use this format:

```
🔍 [Query]

1. **[Title](URL)**
   Snippet or brief description of the page content.

2. **[Title](URL)**
   ...

Sources: [list URLs briefly]
```

Example:
```
🔍 latest iPhone models 2026

1. **[Apple iPhone 17 Pro Max: Everything We Know](https://www.macworld.com/iphone-17-pro)**
   Apple's latest flagship features the A19 Pro chip, titanium frame, and improved camera system with 5x optical zoom.

2. **[iPhone 17 Air: Thinnest iPhone Ever](https://www.theverge.com/iphone-17-air)**
   At 5.5mm thick, the new Air model replaces the Plus line and features a single 48MP camera.

Sources: macworld.com, theverge.com
```

## Edge Cases

### No Results Found
If web_search returns no results:
1. Try rephrasing the query with different keywords
2. Use web_fetch to directly access a known relevant URL

### Ambiguous Queries
If a query is highly ambiguous:
1. Do the search with the most likely interpretation
2. Present results with a note: "I searched for [term] — did you mean something else?"
3. Offer to refine with clarifying suggestions

### Multiple Interpretations
When a query could mean very different things:
1. Search the most likely interpretation
2. Note the ambiguity in the response
3. Offer to search alternative meanings if results don't match intent

### Rate Limiting / Blocked
If DuckDuckGo blocks the request (returns 403 or captcha):
- Wait 30 seconds and retry once
- Do not loop-retry
- Fall back to `web_fetch` on a known relevant URL if available
- Inform the user of the limitation

### Very Long Queries
URL-encode all special characters:
```bash
# Space → %20 or +
# Special chars → percent-encode
curl -s "https://duckduckgo.com/html/?q=$(echo 'site:reddit.com "openclaw"' | jq -sRr @uri)"
```

## Combining with web_fetch

For better results, chain web-search with web-fetch:
1. Use `web-search` to find relevant URLs
2. Use `web-fetch` on the most relevant URL(s) to get full content
3. Synthesize a response from the fetched content

```bash
# Step 1: Find relevant pages
curl -s "https://duckduckgo.com/html/?q=openclaw+plugin+development"

# Step 2: Fetch the best result
# (Use web_fetch tool on the top URL from step 1)
```

## Notes

- DuckDuckGo does not require an API key and has generous rate limits for casual use
- Always URL-encode query parameters to handle special characters correctly
- DuckDuckGo HTML format returns results in a straightforward table format that is parseable

- Prioritize authoritative sources (government, academic, well-known publications) when presenting results
- Be transparent about the recency and reliability of information — DuckDuckGo results may include aged content
