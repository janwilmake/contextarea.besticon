interface IconCandidate {
  url: string;
  width: number;
  height: number;
  type: "apple-touch-icon" | "favicon" | "og-image" | "manifest";
  priority: number;
}

interface ManifestIcon {
  src: string;
  sizes?: string;
  type?: string;
}

interface WebManifest {
  icons?: ManifestIcon[];
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const targetUrl = url.pathname.slice(1); // Remove leading slash

    if (!targetUrl) {
      return new Response("Usage: /{url-to-fetch}", { status: 400 });
    }

    try {
      // Validate and normalize the target URL
      const normalizedUrl = targetUrl.startsWith("http")
        ? targetUrl
        : `https://${targetUrl}`;

      const parsedUrl = new URL(normalizedUrl);

      // Fetch the HTML page
      const response = await fetch(parsedUrl.toString(), {
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "Mozilla/5.0 (compatible; IconFinder/1.0)",
        },
      });

      if (!response.ok) {
        return new Response(
          `Failed to fetch ${parsedUrl}: ${response.status}`,
          { status: 502 },
        );
      }

      const html = await response.text();
      const icons = await extractIcons(html, parsedUrl);

      if (icons.length === 0) {
        return new Response("No icons found", { status: 404 });
      }

      const bestIcon = findBestIcon(icons);

      return fetch(bestIcon.url);
      //   return new Response(
      //     JSON.stringify({
      //       bestIcon: {
      //         url: bestIcon.url,
      //         size: `${bestIcon.width}x${bestIcon.height}`,
      //         type: bestIcon.type,
      //       },
      //       allIcons: icons.map((icon) => ({
      //         url: icon.url,
      //         size: `${icon.width}x${icon.height}`,
      //         type: icon.type,
      //       })),
      //     }),
      //     {
      //       headers: {
      //         "Content-Type": "application/json",
      //         "Access-Control-Allow-Origin": "*",
      //       },
      //     },
      //   );
    } catch (error) {
      return new Response(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        {
          status: 500,
        },
      );
    }
  },
};

async function extractIcons(
  html: string,
  baseUrl: URL,
): Promise<IconCandidate[]> {
  const icons: IconCandidate[] = [];

  // Extract apple-touch-icons (highest priority)
  const appleIconRegex = /<link[^>]*rel=["']apple-touch-icon[^"']*["'][^>]*>/gi;
  const appleMatches = html.match(appleIconRegex) || [];

  for (const match of appleMatches) {
    const href = extractAttribute(match, "href");
    const sizes = extractAttribute(match, "sizes");

    if (href) {
      const iconUrl = resolveUrl(href, baseUrl);
      const { width, height } = parseSizes(sizes);

      icons.push({
        url: iconUrl,
        width,
        height,
        type: "apple-touch-icon",
        priority: 1,
      });
    }
  }

  // Extract regular favicons (second priority)
  const faviconRegex = /<link[^>]*rel=["']icon["'][^>]*>/gi;
  const faviconMatches = html.match(faviconRegex) || [];

  for (const match of faviconMatches) {
    const href = extractAttribute(match, "href");
    const sizes = extractAttribute(match, "sizes");

    if (href) {
      const iconUrl = resolveUrl(href, baseUrl);
      const { width, height } = parseSizes(sizes);

      icons.push({
        url: iconUrl,
        width,
        height,
        type: "favicon",
        priority: 2,
      });
    }
  }

  // Extract Open Graph images (third priority)
  const ogImageRegex = /<meta[^>]*property=["']og:image["'][^>]*>/gi;
  const ogMatches = html.match(ogImageRegex) || [];

  for (const match of ogMatches) {
    const content = extractAttribute(match, "content");

    if (content) {
      const iconUrl = resolveUrl(content, baseUrl);

      icons.push({
        url: iconUrl,
        width: 1200, // OG images are typically large, we'll deprioritize them
        height: 630,
        type: "og-image",
        priority: 3,
      });
    }
  }

  // If no direct icons found, check manifest (lowest priority)
  if (icons.filter((icon) => icon.type !== "og-image").length === 0) {
    const manifestRegex = /<link[^>]*rel=["']manifest["'][^>]*>/gi;
    const manifestMatches = html.match(manifestRegex) || [];

    for (const match of manifestMatches) {
      const href = extractAttribute(match, "href");

      if (href) {
        const manifestUrl = resolveUrl(href, baseUrl);
        const manifestIcons = await fetchManifestIcons(manifestUrl, baseUrl);
        icons.push(...manifestIcons);
      }
    }
  }

  return icons;
}

async function fetchManifestIcons(
  manifestUrl: string,
  baseUrl: URL,
): Promise<IconCandidate[]> {
  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) return [];

    const manifest: WebManifest = await response.json();
    const icons: IconCandidate[] = [];

    if (manifest.icons) {
      for (const icon of manifest.icons) {
        const iconUrl = resolveUrl(icon.src, baseUrl);
        const { width, height } = parseSizes(icon.sizes);

        icons.push({
          url: iconUrl,
          width,
          height,
          type: "manifest",
          priority: 4,
        });
      }
    }

    return icons;
  } catch {
    return [];
  }
}

function extractAttribute(html: string, attributeName: string): string | null {
  const regex = new RegExp(`${attributeName}=["']([^"']*)["']`, "i");
  const match = html.match(regex);
  return match ? match[1] : null;
}

function parseSizes(sizes: string | null): { width: number; height: number } {
  if (!sizes) {
    return { width: 32, height: 32 }; // Default favicon size
  }

  // Handle formats like "32x32", "180x180", etc.
  const match = sizes.match(/(\d+)x(\d+)/);
  if (match) {
    return {
      width: parseInt(match[1]),
      height: parseInt(match[2]),
    };
  }

  // Handle single number (assume square)
  const singleMatch = sizes.match(/(\d+)/);
  if (singleMatch) {
    const size = parseInt(singleMatch[1]);
    return { width: size, height: size };
  }

  return { width: 32, height: 32 };
}

function resolveUrl(href: string, baseUrl: URL): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function findBestIcon(icons: IconCandidate[]): IconCandidate {
  const TARGET_SIZE = 100;

  // Sort by priority first, then by how close to target size
  return icons.sort((a, b) => {
    // First, sort by priority (lower number = higher priority)
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }

    // Then by distance from target size
    const aDistance =
      Math.abs(a.width - TARGET_SIZE) + Math.abs(a.height - TARGET_SIZE);
    const bDistance =
      Math.abs(b.width - TARGET_SIZE) + Math.abs(b.height - TARGET_SIZE);

    return aDistance - bDistance;
  })[0];
}
