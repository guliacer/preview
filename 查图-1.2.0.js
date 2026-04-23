// ==UserScript==
// @name         查图
// @namespace    http://tampermonkey.net/
// @version      1.2.2
// @description  Show a stable enlarged preview on image hover and display the real image size outside the preview.
// @author       guliacer
// @match        *://*/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const PREVIEW_ID = 'image-preview-overlay';
    const SHOW_DELAY = 60;
    const HIDE_DELAY = 180;
    const MIN_IMAGE_SIZE = 20;
    const MIN_RENDER_SIZE = 28;
    const SMALL_ICON_RENDER_SIZE = 56;
    const SMALL_ICON_NATURAL_SIZE = 96;
    const AVATAR_RENDER_SIZE = 180;
    const MAX_SCALE = 1.5;
    const VIEWPORT_MARGIN = 20;
    const PREVIEW_GAP = 15;
    const SIZE_INFO_HEIGHT = 24;

    GM_addStyle(`
        #${PREVIEW_ID} {
            position: fixed;
            z-index: 999999;
            pointer-events: none;
            border-radius: 4px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
            overflow: visible;
            background: rgba(255, 255, 255, 0.93);
            padding: 2px;
            display: none;
            opacity: 0;
            transition: opacity 0.18s ease;
        }

        #${PREVIEW_ID}.show {
            opacity: 1;
        }

        #${PREVIEW_ID} img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            display: block;
            border-radius: 2px;
            background: transparent;
        }

        #${PREVIEW_ID} .img-size-info {
            position: absolute;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            margin-top: 4px;
            background: rgba(0, 0, 0, 0.72);
            color: #fff;
            font-size: 12px;
            padding: 3px 8px;
            border-radius: 4px;
            white-space: nowrap;
            z-index: 1;
            line-height: 1.2;
        }
    `);

    const overlay = document.createElement('div');
    overlay.id = PREVIEW_ID;

    const overlayImage = document.createElement('img');
    overlayImage.alt = 'preview';
    overlayImage.decoding = 'async';

    const sizeInfo = document.createElement('div');
    sizeInfo.className = 'img-size-info';

    overlay.appendChild(overlayImage);
    overlay.appendChild(sizeInfo);
    (document.body || document.documentElement).appendChild(overlay);

    const state = {
        hoveredImage: null,
        lastMouseX: 0,
        lastMouseY: 0,
        showTimer: 0,
        hideTimer: 0,
        rafId: 0,
        visible: false
    };

    function debounce(fn, delay) {
        let timer = 0;
        return (...args) => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => fn(...args), delay);
        };
    }

    function getImageSource(img) {
        return img.currentSrc || img.src || img.getAttribute('src') || '';
    }

    function getImageHintText(img) {
        const parentElement = img.parentElement;
        return [
            img.alt,
            img.getAttribute('aria-label'),
            img.getAttribute('title'),
            img.id,
            img.className,
            parentElement ? parentElement.id : '',
            parentElement ? parentElement.className : '',
            getImageSource(img)
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
    }

    function isLikelyRoundedAvatar(img, rect) {
        const ratio = rect.width / rect.height;
        if (ratio < 0.85 || ratio > 1.15) {
            return false;
        }

        const style = window.getComputedStyle(img);
        const radiusValue = style.borderRadius || '';
        if (radiusValue.includes('%')) {
            return parseFloat(radiusValue) >= 35;
        }

        const radius = Number.parseFloat(radiusValue);
        return Number.isFinite(radius) && radius >= Math.min(rect.width, rect.height) * 0.35;
    }

    function shouldIgnoreImage(img) {
        if (!(img instanceof HTMLImageElement) || !img.isConnected) {
            return true;
        }

        const source = getImageSource(img);
        if (!source) {
            return true;
        }

        const naturalWidth = img.naturalWidth;
        const naturalHeight = img.naturalHeight;
        if (naturalWidth < MIN_IMAGE_SIZE || naturalHeight < MIN_IMAGE_SIZE) {
            return true;
        }

        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return true;
        }

        const renderedMin = Math.min(rect.width, rect.height);
        const renderedMax = Math.max(rect.width, rect.height);
        const naturalMax = Math.max(naturalWidth, naturalHeight);
        const hintText = getImageHintText(img);

        if (renderedMin < MIN_RENDER_SIZE) {
            return true;
        }

        if (renderedMax <= SMALL_ICON_RENDER_SIZE && naturalMax <= SMALL_ICON_NATURAL_SIZE) {
            return true;
        }

        if ((img.getAttribute('role') === 'presentation' || img.getAttribute('aria-hidden') === 'true')
            && renderedMax <= SMALL_ICON_RENDER_SIZE) {
            return true;
        }

        if (/\b(icon|emoji|emote|sticker|smiley|reaction)\b/.test(hintText)
            && renderedMax <= SMALL_ICON_NATURAL_SIZE) {
            return true;
        }

        if (/\b(avatar|profile|portrait|headshot|userpic)\b/.test(hintText)) {
            return true;
        }

        if (isLikelyRoundedAvatar(img, rect)
            && renderedMax <= AVATAR_RENDER_SIZE
            && /\b(user|member|author|account|profile)\b/.test(hintText)) {
            return true;
        }

        return false;
    }

    function isTrackableImage(img) {
        return img instanceof HTMLImageElement
            && !shouldIgnoreImage(img);
    }

    function findImageUnderPointer(mouseX, mouseY) {
        if (typeof document.elementsFromPoint !== 'function') {
            return null;
        }

        const elements = document.elementsFromPoint(mouseX, mouseY);
        for (const element of elements) {
            if (element === overlay) {
                continue;
            }

            if (isTrackableImage(element)) {
                return element;
            }
        }

        return null;
    }

    function calculatePreview(targetImg, mouseX, mouseY) {
        if (!isTrackableImage(targetImg)) {
            return null;
        }

        const rect = targetImg.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return null;
        }

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const imgWidth = targetImg.naturalWidth;
        const imgHeight = targetImg.naturalHeight;
        const imgCenterX = rect.left + rect.width / 2;

        const widthRatio = (viewportWidth - VIEWPORT_MARGIN * 2) / imgWidth;
        const heightRatio = (viewportHeight - VIEWPORT_MARGIN * 2 - SIZE_INFO_HEIGHT) / imgHeight;
        const scale = Math.min(widthRatio, heightRatio, MAX_SCALE);

        if (!Number.isFinite(scale) || scale <= 0) {
            return null;
        }

        const finalWidth = Math.max(1, Math.round(imgWidth * scale));
        const finalHeight = Math.max(1, Math.round(imgHeight * scale));

        const preferRight = mouseX < imgCenterX;
        const rightSpace = viewportWidth - rect.right - PREVIEW_GAP - VIEWPORT_MARGIN;
        const leftSpace = rect.left - PREVIEW_GAP - VIEWPORT_MARGIN;

        let left;
        if (preferRight && rightSpace >= finalWidth) {
            left = rect.right + PREVIEW_GAP;
        } else if (!preferRight && leftSpace >= finalWidth) {
            left = rect.left - finalWidth - PREVIEW_GAP;
        } else if (rightSpace >= leftSpace) {
            left = rect.right + PREVIEW_GAP;
        } else {
            left = rect.left - finalWidth - PREVIEW_GAP;
        }

        left = Math.max(VIEWPORT_MARGIN, Math.min(left, viewportWidth - finalWidth - VIEWPORT_MARGIN));

        const top = Math.max(
            VIEWPORT_MARGIN,
            Math.min(
                mouseY - finalHeight / 2,
                viewportHeight - finalHeight - VIEWPORT_MARGIN - SIZE_INFO_HEIGHT
            )
        );

        return {
            src: getImageSource(targetImg),
            left: `${Math.round(left)}px`,
            top: `${Math.round(top)}px`,
            width: `${finalWidth}px`,
            height: `${finalHeight}px`,
            realWidth: imgWidth,
            realHeight: imgHeight
        };
    }

    function clearShowTimer() {
        if (state.showTimer) {
            window.clearTimeout(state.showTimer);
            state.showTimer = 0;
        }
    }

    function clearHideTimer() {
        if (state.hideTimer) {
            window.clearTimeout(state.hideTimer);
            state.hideTimer = 0;
        }
    }

    function cancelRenderFrame() {
        if (state.rafId) {
            window.cancelAnimationFrame(state.rafId);
            state.rafId = 0;
        }
    }

    function finalizeHide() {
        clearHideTimer();
        cancelRenderFrame();
        overlay.classList.remove('show');
        overlay.style.display = 'none';
        overlayImage.removeAttribute('src');
        sizeInfo.textContent = '';
        state.visible = false;
    }

    function hidePreview(immediate) {
        clearShowTimer();
        clearHideTimer();

        if (immediate || !state.visible) {
            finalizeHide();
            return;
        }

        overlay.classList.remove('show');
        state.hideTimer = window.setTimeout(finalizeHide, HIDE_DELAY);
    }

    function renderPreview(targetImg) {
        const preview = calculatePreview(targetImg, state.lastMouseX, state.lastMouseY);
        if (!preview) {
            hidePreview(true);
            return;
        }

        if (overlayImage.src !== preview.src) {
            overlayImage.src = preview.src;
        }

        overlay.style.left = preview.left;
        overlay.style.top = preview.top;
        overlay.style.width = preview.width;
        overlay.style.height = preview.height;
        sizeInfo.textContent = `${preview.realWidth} x ${preview.realHeight} px`;

        clearHideTimer();

        if (!state.visible) {
            overlay.style.display = 'block';
            requestAnimationFrame(() => overlay.classList.add('show'));
            state.visible = true;
        }
    }

    function scheduleRender() {
        cancelRenderFrame();
        state.rafId = window.requestAnimationFrame(() => {
            state.rafId = 0;
            if (state.hoveredImage) {
                renderPreview(state.hoveredImage);
            }
        });
    }

    function scheduleShow(targetImg) {
        clearShowTimer();
        clearHideTimer();

        state.showTimer = window.setTimeout(() => {
            state.showTimer = 0;
            if (state.hoveredImage === targetImg) {
                renderPreview(targetImg);
            }
        }, SHOW_DELAY);
    }

    function handlePointerMove(event) {
        state.lastMouseX = event.clientX;
        state.lastMouseY = event.clientY;

        const nextImage = findImageUnderPointer(state.lastMouseX, state.lastMouseY);
        if (nextImage !== state.hoveredImage) {
            state.hoveredImage = nextImage;

            if (!nextImage) {
                hidePreview(false);
                return;
            }

            scheduleShow(nextImage);
            return;
        }

        if (nextImage && state.visible) {
            scheduleRender();
        }
    }

    const refreshPreview = debounce(() => {
        if (state.hoveredImage && state.visible) {
            renderPreview(state.hoveredImage);
        }
    }, 50);

    overlayImage.addEventListener('error', () => {
        hidePreview(true);
    });

    document.addEventListener('mousemove', handlePointerMove, true);

    document.addEventListener('mouseleave', () => {
        state.hoveredImage = null;
        hidePreview(false);
    }, true);

    window.addEventListener('blur', () => {
        state.hoveredImage = null;
        hidePreview(true);
    });

    window.addEventListener('resize', refreshPreview);
    window.addEventListener('scroll', refreshPreview, true);
})();
