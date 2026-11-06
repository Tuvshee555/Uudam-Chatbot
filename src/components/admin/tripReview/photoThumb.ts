/** A small Cloudinary rendition (other hosts as they are). */
export function thumb(url: string, width: number, height: number): string {
  return url.includes("res.cloudinary.com/") && url.includes("/upload/")
    ? url.replace("/upload/", `/upload/c_fill,w_${width},h_${height},q_auto,f_auto/`)
    : url;
}
