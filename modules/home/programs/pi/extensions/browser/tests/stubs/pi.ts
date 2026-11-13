// Stand-ins for Pi's packages, so index.ts loads under `node --test` (see rows.test.ts).
export const convertToPng = async (data: string) => ({ data, mimeType: "image/png" });
export const getCapabilities = () => ({ images: "kitty" });
export const getCellDimensions = () => ({ widthPx: 10, heightPx: 20 });
export const getImageDimensions = () => ({ widthPx: 640, heightPx: 400 });
export const renderImage = (_png: string, _dims: unknown, o: { maxWidthCells: number; maxHeightCells: number; imageId: number }) => ({
	sequence: `\x1b_Ga=T,f=100,i=${o.imageId},c=${o.maxWidthCells},r=${o.maxHeightCells};AAAA\x1b\\`,
	rows: o.maxHeightCells,
	columns: o.maxWidthCells,
});
export const visibleWidth = (s: string) => [...s.replace(/\x1b_G[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")].length;
export const truncateToWidth = (s: string, w: number) => ([...s].length <= w ? s : `${[...s].slice(0, w - 1).join("")}…`);
