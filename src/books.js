import fetch from "node-fetch";

function buildBooksUrl(query, apiKey) {
  const base = "https://www.googleapis.com/books/v1/volumes";
  const params = new URLSearchParams({
    q: query,
    maxResults: "5",
    printType: "books",
    langRestrict: "ru" // можешь убрать или сделать динамически
  });
  if (apiKey) params.set("key", apiKey);
  return `${base}?${params.toString()}`;
}

export async function findBook(query, apiKey) {
  const url = buildBooksUrl(query, apiKey);
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = await res.json();
  const item = data?.items?.[0];
  if (!item) return null;

  const info = item.volumeInfo || {};
  return {
    title: info.title || null,
    authors: info.authors || [],
    description: info.description || null,
    canonicalLink: info.canonicalVolumeLink || info.infoLink || null
  };
}