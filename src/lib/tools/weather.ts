/**
 * Free Open-Meteo Weather & Forecasting Integration
 * Zero API keys or authentication required.
 */

export interface WeatherResult {
  success: boolean;
  location?: string;
  latitude?: number;
  longitude?: number;
  current?: {
    temperature: number;
    unit: string;
    weatherDescription: string;
    windSpeed: number;
    humidity?: number;
  };
  daily?: Array<{
    date: string;
    tempMax: number;
    tempMin: number;
    precipitationProbabilityMax: number;
    weatherDescription: string;
  }>;
  error?: string;
}

const WMO_CODE_MAP: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

export async function fetchWeather(locationQuery: string): Promise<WeatherResult> {
  const query = (locationQuery || "").trim();
  if (!query) {
    return { success: false, error: "Location query must not be empty." };
  }

  try {
    // 1. Free Open-Meteo Geocoding API
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
    const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(6000) });
    if (!geoRes.ok) {
      return { success: false, error: `Geocoding lookup failed with status ${geoRes.status}.` };
    }

    const geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) {
      return { success: false, error: `Could not find location coordinates for "${query}".` };
    }

    const loc = geoData.results[0];
    const lat = loc.latitude;
    const lon = loc.longitude;
    const resolvedName = [loc.name, loc.admin1, loc.country].filter(Boolean).join(", ");

    // 2. Free Open-Meteo Weather Forecast API
    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
    const weatherRes = await fetch(forecastUrl, { signal: AbortSignal.timeout(6000) });
    if (!weatherRes.ok) {
      return { success: false, error: `Weather forecast lookup failed with status ${weatherRes.status}.` };
    }

    const weatherData = await weatherRes.json();
    const current = weatherData.current;
    const daily = weatherData.daily;

    const weatherDesc = WMO_CODE_MAP[current?.weather_code] || "Variable conditions";

    const dailyForecast = (daily?.time || []).slice(0, 3).map((timeStr: string, idx: number) => ({
      date: timeStr,
      tempMax: daily.temperature_2m_max?.[idx],
      tempMin: daily.temperature_2m_min?.[idx],
      precipitationProbabilityMax: daily.precipitation_probability_max?.[idx] ?? 0,
      weatherDescription: WMO_CODE_MAP[daily.weather_code?.[idx]] || "Clear",
    }));

    return {
      success: true,
      location: resolvedName,
      latitude: lat,
      longitude: lon,
      current: {
        temperature: current.temperature_2m,
        unit: weatherData.current_units?.temperature_2m || "°C",
        weatherDescription: weatherDesc,
        windSpeed: current.wind_speed_10m,
        humidity: current.relative_humidity_2m,
      },
      daily: dailyForecast,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Network error retrieving weather: ${err?.message || String(err)}`,
    };
  }
}
