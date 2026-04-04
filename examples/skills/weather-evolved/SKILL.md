---
name: weather
description: "Get current weather conditions and multi-day forecasts via wttr.in or Open-Meteo. Use when: user asks about weather, temperature, precipitation, or forecasts for any location. NOT for: historical weather data, severe weather alerts/warnings, detailed meteorological analysis, or hyper-local microclimate data. No API key needed."
homepage: https://wttr.in/:help
metadata:
  {
    "openclaw":
      {
        "emoji": "☔",
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

# Weather Skill

Get current weather conditions and forecasts for any location using wttr.in or Open-Meteo.

## When to Use

✅ **USE this skill when:**

- User asks "what's the weather?" or "how's the weather in [place]?"
- User asks about temperature, rain, snow, or forecasts
- Travel planning: checking weather at a destination
- "Should I take an umbrella?" or "Do I need a jacket?"
- Multi-day planning: "What's the forecast for the weekend?"

❌ **DO NOT use this skill when:**

- Asking for historical weather data → suggest weather archives or NOAA
- Severe weather alerts (tornadoes, hurricanes, floods) → direct to official NWS/alerts
- Long-term climate trends or averages → use specialized climate data sources
- Aviation weather (METAR/TAF) → use aviation-specific services
- Marine or ocean conditions → use marine weather services

## Prerequisites

- Requires `curl` to be installed
- No API key required (uses public wttr.in or Open-Meteo)

## Tool Usage

### Current Conditions — `curl wttr.in`

Always prefer the one-line format for quick responses:

```bash
# One-line summary (preferred for chat responses)
curl -s "wttr.in/London?format=3"

# With feels-like temperature
curl -s "wttr.in/London?format=%l:+%c+%t,+feels+like+%f"

# Wind and humidity inline
curl -s "wttr.in/London?format=%l:+%c+%t+(feels+%f),+%w+wind,+%h+humidity"
```

For structured data, request JSON:

```bash
curl -s "wttr.in/London?format=j1" | jq '.current_condition[0]'
```

### Multi-Day Forecasts

```bash
# 3-day standard forecast (default)
curl -s "wttr.in/London"

# Verbose week forecast (v2 format includes hourly data)
curl -s "wttr.in/London?format=v2"

# Specific day: 0=today, 1=tomorrow, 2=day+2
curl -s "wttr.in/London?1"
```

### Format Codes

| Code | Meaning         |
|------|-----------------|
| `%l` | Location name   |
| `%c` | Condition emoji |
| `%t` | Temperature     |
| `%f` | Feels-like temp |
| `%w` | Wind speed/dir  |
| `%h` | Humidity %      |
| `%p` | Precipitation   |
| `%P` | Pressure        |

### Location Formats

```bash
# City name
curl -s "wttr.in/Paris"

# City + country code
curl -s "wttr.in/New+York?format=3"

# Airport code (works globally)
curl -s "wttr.in/LAX?format=3"

# Latitude/longitude
curl -s "wttr.in/~48.8,-122.5?format=3"
```

## Response Templates

### Quick Current Conditions
```
[Location]: [Condition emoji] [Temperature] (feels like [FeelsLike])
Wind: [Wind] | Humidity: [Humidity]%
```

### "Will it rain?"
```bash
curl -s "wttr.in/London?format=%l:+%c+%p+chance+of+precipitation"
```

### "Do I need a jacket?"
```bash
curl -s "wttr.in/London?format=%l:+%c+%t+(feels+%f)+—+bring+a+jacket+if+feels+below+10°C"
```

### Weekend Forecast (3-day)
```bash
curl -s "wttr.in/London?format=v2"
```

## Edge Cases

### City Not Found
If wttr.in returns an unknown location, try:
1. Add country code: `London,UK` instead of `London`
2. Try airport/IATA code instead of city name
3. Fall back to lat/lon coordinates if available in context

### Rate Limiting
wttr.in is a free public service. If requests fail with rate limit errors:
- Wait 10-15 seconds and retry once
- Do not loop-retry; report the limitation to the user
- Suggest they check wttr.in directly if urgent

### No Location Provided
If user says "what's the weather?" without specifying a location:
- Check conversation history for a previously mentioned location
- If none found, ask the user to specify a city or location

### Special Characters in Location
Always URL-encode spaces with `+`:
```bash
# San Francisco → San+Francisco
curl -s "wttr.in/San+Francisco?format=3"
```

### Global Cities Not in wttr.in Database
For small towns or rural areas not in wttr.in:
1. Try nearest major city
2. Try IATA airport code for the area
3. Fall back to Open-Meteo with lat/lon if coordinates are known
4. Tell user the nearest available data point

## Open-Meteo Fallback

When wttr.in is unavailable or for more accurate data:

```bash
# Open-Meteo current weather (no API key)
curl -s "https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&current_weather=true"
```

## Notes

- **No API key needed** for either service
- wttr.in works for most cities worldwide; Open-Meteo is more reliable for less-known locations
- Always include units when presenting temperature (°C or °F — use whatever is standard for the user's likely location)
- wttr.in may occasionally return 503 on heavy load; retry once after a short wait
