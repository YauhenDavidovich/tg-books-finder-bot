import fetch from "node-fetch";

function buildUrl(title, author, apiKey) {
  const base = "https://www.googleapis.com/books/v1/volumes";
  const qParts = [];
  if (title) qParts.push(`intitle:${title}`);
  if (author) qParts.push(`inauthor:${author}`);

  const params = new URLSearchParams({
    q: qParts.join(" "),
    maxResults: "5",
    printType: "books"
  });

  if (apiKey) params.set("key", apiKey);
  return `${base}?${params.toString()}`;
}

export async function findBookByTitleAuthor({ title, author }, apiKey) {
  const url = buildUrl(title, author, apiKey);
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