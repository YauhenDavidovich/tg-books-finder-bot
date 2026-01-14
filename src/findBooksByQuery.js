import fetch from "node-fetch";

export async function findBooksByQuery(query, apiKey) {
  const base = "https://www.googleapis.com/books/v1/volumes";
  const params = new URLSearchParams({
    q: query,
    maxResults: "5",
    printType: "books",
  });
  if (apiKey) params.set("key", apiKey);

  const res = await fetch(`${base}?${params.toString()}`);
  if (!res.ok) return [];

  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];

  return items.map((it) => {
    const info = it.volumeInfo || {};
    return {
      title: info.title || null,
      authors: info.authors || [],
      description: info.description || null,
      canonicalLink: info.canonicalVolumeLink || info.infoLink || null,
    };
  });
}