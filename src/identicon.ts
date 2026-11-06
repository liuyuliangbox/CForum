
export async function generateIdenticonSvg(seed: string): Promise<string> {
	const msgBuffer = new TextEncoder().encode(seed);
	const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));

	const r = 40 + (hashArray[0] % 180);
	const g = 40 + (hashArray[1] % 180);
	const b = 40 + (hashArray[2] % 180);
	const color = `rgb(${r},${g},${b})`;
	const bgR = 220 + (hashArray[3] % 30);
	const bgG = 220 + (hashArray[4] % 30);
	const bgB = 220 + (hashArray[5] % 30);
	const bg = `rgb(${bgR},${bgG},${bgB})`;

	const rects: string[] = [];
	let idx = 6;

	for (let row = 0; row < 5; row++) {
		const rowData: boolean[] = [];
		for (let col = 0; col < 3; col++) {
			const byte = hashArray[idx % hashArray.length];
			rowData.push(byte % 2 === 0);
			idx++;
		}

		const cells = [rowData[0], rowData[1], rowData[2], rowData[1], rowData[0]];

		for (let col = 0; col < 5; col++) {
			if (cells[col]) {
				rects.push(`<rect x="${col * 10}" y="${row * 10}" width="10" height="10" fill="${color}" />`);
			}
		}
	}

	return `
    <svg width="100" height="100" viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
        <rect width="50" height="50" rx="8" ry="8" fill="${bg}" />
        ${rects.join('')}
    </svg>
    `.trim().replace(/\s+/g, ' ');
}

export async function generateIdenticon(seed: string): Promise<string> {
	const svgContent = await generateIdenticonSvg(seed);
	const base64 = btoa(svgContent);
	return `data:image/svg+xml;base64,${base64}`;
}
