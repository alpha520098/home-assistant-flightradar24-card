import { applyFilter } from '../utils/filter';
import { handleFlightTap } from '../utils/action';
import type { Flight } from '../types/flight';
import type { Condition, AircraftMarkerEntry } from '../types/config';
import type { CardState } from '../types/cardState';

const DISPLAY_SIZE = 12;

const imgCache = new Map<string, Promise<HTMLImageElement>>();
const renderCache = new Map<string, Promise<HTMLCanvasElement>>();

function parseMarkerCenter(center: string | undefined): [number, number] {
    if (!center) return [0, 0];
    const parts = center.split(',').map(Number);
    return [parts[0] || 0, parts[1] || 0];
}

interface ParsedShadow {
    offsetX: number;
    offsetY: number;
    blur: number;
    color: string;
}

function parseShadow(shadow: string): ParsedShadow {
    const result: ParsedShadow = { offsetX: 0, offsetY: 0, blur: 0, color: 'rgba(0,0,0,0.5)' };
    if (!shadow) return result;
    const parts = shadow.trim().split(/\s+/);
    if (parts.length < 2) return result;
    result.offsetX = parseFloat(parts[0]) || 0;
    result.offsetY = parseFloat(parts[1]) || 0;
    let ci = 2;
    if (parts.length > 2 && /^[\d.]+(?:px|em|rem|pt|cm|mm|in|pc|ex|ch|vw|vh|vmin|vmax)$/i.test(parts[2])) {
        result.blur = Math.max(0, parseFloat(parts[2]) || 0);
        ci = 3;
    }
    if (parts.length > ci) {
        result.color = parts.slice(ci).join(' ');
    }
    return result;
}

function loadImage(url: string): Promise<HTMLImageElement> {
    const cached = imgCache.get(url);
    if (cached) return cached;
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load marker image: ${url}`));
        img.src = url;
    });
    imgCache.set(url, promise);
    return promise;
}

function renderMarker(img: HTMLImageElement, entry: AircraftMarkerEntry): HTMLCanvasElement {
    const iw = img.width;
    const ih = img.height;
    const pxRatio = iw / DISPLAY_SIZE;

    const overlayColor = entry['aircraft-marker-color-overlay'];
    const outlineWidth = entry['aircraft-marker-outline-width'] ?? 0;
    const outlineColor = entry['aircraft-marker-outline-color'] || '#000000';
    const shadow = entry['aircraft-marker-shadow'] || '';

    const sp = parseShadow(shadow);
    const csOffX = Math.round(sp.offsetX * pxRatio);
    const csOffY = Math.round(sp.offsetY * pxRatio);
    const csBlur = Math.round(sp.blur * pxRatio);

    const csOutline = Math.ceil(outlineWidth * pxRatio);
    const outlineBlur = Math.max(1, Math.round(csOutline * 0.4));

    const pad = Math.ceil(Math.max(
        csOutline + outlineBlur * 2,
        Math.abs(csOffX) + csBlur * 2,
        Math.abs(csOffY) + csBlur * 2,
    ));
    const cw = iw + 2 * pad;
    const ch = ih + 2 * pad;

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d')!;

    const bx = pad;
    const by = pad;

    // Layer 1: Shadow
    if (shadow && (csOffX !== 0 || csOffY !== 0 || csBlur > 0)) {
        const sc = document.createElement('canvas');
        sc.width = iw;
        sc.height = ih;
        const sctx = sc.getContext('2d')!;
        sctx.drawImage(img, 0, 0, iw, ih);
        sctx.globalCompositeOperation = 'source-atop';
        sctx.fillStyle = sp.color;
        sctx.fillRect(0, 0, iw, ih);

        ctx.save();
        if (csBlur > 0) ctx.filter = `blur(${csBlur}px)`;
        ctx.drawImage(sc, bx + csOffX, by + csOffY, iw, ih);
        ctx.restore();
    }

    // Layer 2: Outline
    if (csOutline > 0) {
        const oc = document.createElement('canvas');
        oc.width = cw;
        oc.height = ch;
        const octx = oc.getContext('2d')!;
        const sw = iw + 2 * csOutline;
        const sh = ih + 2 * csOutline;
        octx.save();
        octx.filter = `blur(${outlineBlur}px)`;
        octx.drawImage(img, bx - csOutline, by - csOutline, sw, sh);
        octx.filter = 'none';
        octx.globalCompositeOperation = 'source-atop';
        octx.fillStyle = outlineColor;
        octx.fillRect(0, 0, cw, ch);
        octx.restore();

        ctx.drawImage(oc, 0, 0);
    }

    // Layer 3: Main image
    ctx.drawImage(img, bx, by, iw, ih);
    if (overlayColor) {
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = overlayColor;
        ctx.fillRect(bx, by, iw, ih);
    }

    return canvas;
}

function markerCacheKey(entry: AircraftMarkerEntry): string {
    return `${entry['aircraft-marker-url']}|${entry['aircraft-marker-color-overlay']}|${entry['aircraft-marker-outline-width']}|${entry['aircraft-marker-outline-color']}|${entry['aircraft-marker-shadow']}`;
}

function getOrCreateRenderPromise(entry: AircraftMarkerEntry): Promise<HTMLCanvasElement> {
    const key = markerCacheKey(entry);
    const cached = renderCache.get(key);
    if (cached) return cached;
    const promise = loadImage(entry['aircraft-marker-url']).then(img => renderMarker(img, entry));
    renderCache.set(key, promise);
    return promise;
}

function createCustomMarker(entry: AircraftMarkerEntry, heading: number): HTMLDivElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-marker';

    const transformEl = document.createElement('div');
    transformEl.className = 'custom-marker-transform';
    wrapper.appendChild(transformEl);

    const url = entry['aircraft-marker-url'];
    const overlayColor = entry['aircraft-marker-color-overlay'];
    const outlineWidth = entry['aircraft-marker-outline-width'] ?? 0;
    const outlineColor = entry['aircraft-marker-outline-color'] || '#000000';
    const shadow = entry['aircraft-marker-shadow'] || '';

    const hasEffects = overlayColor || outlineWidth > 0 || shadow.length > 0;

    if (hasEffects) {
        const canvas = document.createElement('canvas');
        transformEl.appendChild(canvas);

        getOrCreateRenderPromise(entry)
            .then(src => {
                canvas.width = src.width;
                canvas.height = src.height;
                canvas.getContext('2d')!.drawImage(src, 0, 0);
            })
            .catch(() => {});
    } else {
        const img = document.createElement('img');
        img.src = url;
        img.draggable = false;
        transformEl.appendChild(img);
    }

    const rotation = entry['aircraft-marker-rotation'] ?? 0;
    const scaleVal = entry['aircraft-marker-scale'] ?? 1;
    const [centerX, centerY] = parseMarkerCenter(entry['aircraft-marker-center']);

    transformEl.style.transform = `rotate(${heading + rotation}deg) scale(${scaleVal})`;
    transformEl.style.transformOrigin = `calc(50% + ${centerX}px) calc(50% + ${centerY}px)`;

    return wrapper;
}

function textValue(value: unknown): string {
    if (value === undefined || value === null) return '';
    const text = String(value).trim();
    return text === 'undefined' || text === 'null' ? '' : text;
}

function formatAltitude(cardState: CardState, flight: Flight): string {
    if (!Number.isFinite(flight.altitude) || flight.altitude <= 0) return '';
    if (flight.altitude >= 17750) return `FL${Math.round(flight.altitude / 1000) * 10}`;
    if (cardState.units.altitude === 'm') return `${Math.round(flight.altitude * 0.3048).toLocaleString()} m`;
    return `${Math.round(flight.altitude).toLocaleString()} ft`;
}

function formatSpeed(cardState: CardState, flight: Flight): string {
    if (!Number.isFinite(flight.ground_speed) || flight.ground_speed <= 0) return '';
    if (cardState.units.speed === 'kmh') return `${Math.round(flight.ground_speed * 1.852).toLocaleString()} km/h`;
    if (cardState.units.speed === 'mph') return `${Math.round(flight.ground_speed * 1.15078).toLocaleString()} mph`;
    return `${Math.round(flight.ground_speed).toLocaleString()} kts`;
}

function appendPopupLine(popup: HTMLElement, className: string, text: string): void {
    if (!text) return;
    const line = document.createElement('div');
    line.className = className;
    line.textContent = text;
    popup.appendChild(line);
}

function createFlightPopup(cardState: CardState, flight: Flight): HTMLDivElement {
    const popup = document.createElement('div');
    popup.className = 'flight-radar-popup';
    popup.setAttribute('role', 'status');
    popup.dataset.flightId = flight.id;

    const callsign = textValue(flight.callsign) || textValue(flight.flight_number) || textValue(flight.aircraft_registration) || 'Unknown flight';
    const airline = textValue(flight.airline_short) || textValue(flight.airline);
    const model = textValue(flight.aircraft_model);
    const aircraftDetails = [textValue(flight.aircraft_code), textValue(flight.aircraft_registration)].filter(Boolean).join(' • ');
    const performance = [formatAltitude(cardState, flight), formatSpeed(cardState, flight)].filter(Boolean).join(' • ');
    const route = [textValue(flight.airport_origin_code_iata), textValue(flight.airport_destination_code_iata)].filter(Boolean).join(' → ');
    const squawk = textValue(flight.squawk);

    appendPopupLine(popup, 'flight-popup-title', callsign);
    appendPopupLine(popup, 'flight-popup-airline', airline);
    appendPopupLine(popup, 'flight-popup-model', model);
    appendPopupLine(popup, 'flight-popup-row', aircraftDetails);
    appendPopupLine(popup, 'flight-popup-row', performance);
    appendPopupLine(popup, 'flight-popup-route', route);

    if (squawk) {
        const squawkLine = document.createElement('div');
        squawkLine.className = 'flight-popup-squawk';
        squawkLine.textContent = `Squawk ${squawk}`;
        if (squawk === '7700') {
            squawkLine.classList.add('emergency');
            popup.classList.add('flight-radar-popup-emergency');
        }
        popup.appendChild(squawkLine);
    }

    return popup;
}

function positionFlightPopup(popup: HTMLDivElement, x: number, y: number, radarWidth: number, radarHeight: number): void {
    const edgePadding = 8;
    const gap = 18;
    const popupWidth = popup.offsetWidth || 190;
    const popupHeight = popup.offsetHeight || 110;

    let left = x <= radarWidth / 2 ? x + gap : x - popupWidth - gap;
    let top = y - popupHeight / 2;

    if (left < edgePadding) left = x + gap;
    if (left + popupWidth > radarWidth - edgePadding) left = x - popupWidth - gap;

    left = Math.max(edgePadding, Math.min(radarWidth - popupWidth - edgePadding, left));
    top = Math.max(edgePadding, Math.min(radarHeight - popupHeight - edgePadding, top));

    const popupIsLeftOfPlane = left + popupWidth <= x;
    popup.classList.add(popupIsLeftOfPlane ? 'popup-left' : 'popup-right');
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
}

export function renderRadar(cardState: CardState): void {
    const { flights, radar, selectedFlights, dimensions, dom } = cardState;

    let flightsToRender: Flight[];
    if (radar && radar.filter === true) {
        flightsToRender = cardState.flightsFiltered || flights;
    } else if (radar && radar.filter && typeof radar.filter === 'object') {
        flightsToRender = applyFilter(cardState, radar.filter as Condition[]);
    } else {
        flightsToRender = flights;
    }

    const planesContainer = dom?.planesContainer || (cardState.mainCard?.shadowRoot && cardState.mainCard.shadowRoot.getElementById('planes'));
    if (!planesContainer) return;
    planesContainer.innerHTML = '';

    const { range: radarRange, scaleFactor, centerX: radarCenterX, centerY: radarCenterY, width: radarWidth, height: radarHeight } = dimensions;
    if (!radarRange || !scaleFactor || radarCenterX === undefined || radarCenterY === undefined) return;

    const clippingRange = radarRange * 1.15;
    const aircraftMarkerConfig = radar?.['aircraft-marker'];
    const defaultMarkerEntry = aircraftMarkerConfig?.default;

    flightsToRender
        .slice()
        .reverse()
        .forEach((flight) => {
            const distance = flight.distance_to_tracker;
            if (distance !== undefined && distance <= clippingRange) {
                const plane = document.createElement('div');
                plane.className = 'plane';

                const headingFromTracker = flight.heading_from_tracker ?? 0;
                const x = radarCenterX + Math.cos(((headingFromTracker - 90) * Math.PI) / 180) * distance * scaleFactor;
                const y = radarCenterY + Math.sin(((headingFromTracker - 90) * Math.PI) / 180) * distance * scaleFactor;

                plane.style.top = y + 'px';
                plane.style.left = x + 'px';

                if (defaultMarkerEntry?.['aircraft-marker-url']) {
                    plane.classList.add('plane-custom');
                    const marker = createCustomMarker(defaultMarkerEntry, flight.heading ?? 0);
                    plane.appendChild(marker);
                } else {
                    const arrow = document.createElement('div');
                    arrow.className = 'arrow';
                    arrow.style.transform = `rotate(${flight.heading}deg)`;
                    plane.appendChild(arrow);

                    if ((flight.altitude ?? 0) <= 0) {
                        plane.classList.add('plane-small');
                    } else {
                        plane.classList.add('plane-medium');
                    }
                }

                const label = document.createElement('div');
                label.className = 'callsign-label';
                label.textContent = flight.callsign ?? flight.aircraft_registration ?? 'n/a';
                planesContainer.appendChild(label);

                const labelRect = label.getBoundingClientRect();
                const labelWidth = labelRect.width + 3;
                const labelHeight = labelRect.height + 6;

                label.style.top = y - labelHeight + 'px';
                label.style.left = x - labelWidth + 'px';

                const markerSize = radar['aircraft-marker-size'];
                if (markerSize && markerSize !== 'normal') {
                    plane.classList.add(`marker-size-${markerSize}`);
                }

                const isSelected = !!(selectedFlights && selectedFlights.includes(flight.id));
                if (isSelected) {
                    plane.classList.add('selected');
                    label.classList.add('selected-flight-label');
                }

                plane.addEventListener('click', (e) => { e.stopPropagation(); handleFlightTap(cardState, flight); });
                label.addEventListener('click', (e) => { e.stopPropagation(); handleFlightTap(cardState, flight); });
                planesContainer.appendChild(plane);

                if (isSelected) {
                    const popup = createFlightPopup(cardState, flight);
                    planesContainer.appendChild(popup);
                    positionFlightPopup(
                        popup,
                        x,
                        y,
                        radarWidth || radarCenterX * 2,
                        radarHeight || radarCenterY * 2
                    );
                }
            }
        });
}
