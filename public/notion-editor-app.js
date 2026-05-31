import { ToastManager } from './managers/toaster.js';
import SearchManager from './managers/search.js';
import StorageManager from './managers/storage.js';
import { marked } from '/js/marked/marked.esm.js';

document.addEventListener('DOMContentLoaded', async () => {
    const THEME_KEY = 'dumbpad_theme';
    const SETTINGS_KEY = 'dumbpad_wysiwyg_settings';

    const settingsDefaults = {
        saveStatusMessageInterval: 600,
    };

    const elements = {
        pageTitle: document.getElementById('page-title'),
        headerTitle: document.getElementById('header-title'),
        copyLinkBtn: document.getElementById('copy-link'),
        searchBtn: document.getElementById('search-open'),
        settingsBtn: document.getElementById('settings-button'),
        themeToggle: document.getElementById('theme-toggle'),
        notepadSelector: document.getElementById('notepad-selector'),
        newNotepadBtn: document.getElementById('new-notepad'),
        renameNotepadBtn: document.getElementById('rename-notepad'),
        downloadNotepadBtn: document.getElementById('download-notepad'),
        printNotepadBtn: document.getElementById('print-notepad'),
        exportMarkdownBtn: document.getElementById('preview-markdown'),
        deleteNotepadBtn: document.getElementById('delete-notepad'),
        quickCreateNoteButton: document.getElementById('quick-create-note'),
        attachFilesButton: document.getElementById('attach-files-button'),
        attachFilesInput: document.getElementById('attach-files-input'),
        attachFilesHelp: document.getElementById('attach-files-help'),
        uploadsSelectAllBtn: document.getElementById('uploads-select-all'),
        uploadsClearSelectionBtn: document.getElementById('uploads-clear-selection'),
        uploadsDeleteSelectedBtn: document.getElementById('uploads-delete-selected'),
        uploadsList: document.getElementById('uploads-list'),
        uploadsTabs: document.querySelectorAll('.uploads-tab'),
        uploadPreviewModal: document.getElementById('upload-preview-modal'),
        uploadPreviewTitle: document.getElementById('upload-preview-title'),
        uploadPreviewFrame: document.getElementById('upload-preview-frame'),
        uploadPreviewImage: document.getElementById('upload-preview-image'),
        uploadPreviewCloseBtn: document.getElementById('upload-preview-close'),
        uploadPreviewDownloadBtn: document.getElementById('upload-preview-download'),
        editorRoot: document.getElementById('notion-editor'),
        toastContainer: document.getElementById('toast-container'),
        renameModal: document.getElementById('rename-modal'),
        deleteModal: document.getElementById('delete-modal'),
        downloadModal: document.getElementById('download-modal'),
        settingsModal: document.getElementById('settings-modal'),
        renameInput: document.getElementById('rename-input'),
        renameCancel: document.getElementById('rename-cancel'),
        renameConfirm: document.getElementById('rename-confirm'),
        deleteCancel: document.getElementById('delete-cancel'),
        deleteConfirm: document.getElementById('delete-confirm'),
        downloadCancel: document.getElementById('download-cancel'),
        downloadTxt: document.getElementById('download-txt'),
        downloadMd: document.getElementById('download-md'),
        settingsCancel: document.getElementById('settings-cancel'),
        settingsSave: document.getElementById('settings-save'),
        settingsReset: document.getElementById('settings-reset'),
        settingsInputAutoSaveStatusInterval: document.getElementById('autosave-status-interval-input'),
        tooltips: document.querySelectorAll('[data-tooltip]'),
    };

    const QuillCtor = window.Quill;
    const TurndownServiceCtor = window.TurndownService;
    const highlightJs = window.hljs;

    if (!QuillCtor || !TurndownServiceCtor) {
        const fallbackToaster = new ToastManager(elements.toastContainer);
        fallbackToaster.show('Editor library failed to load', 'error', true, 5000);
        return;
    }

    function configureHighlightSyntax() {
        if (!highlightJs) {
            return false;
        }

        const versionString = String(highlightJs.versionString || '');
        const majorVersion = parseInt(versionString.split('.')[0], 10);

        // Quill expects highlight.js < v11 to use `useBR: false`.
        if (!Number.isNaN(majorVersion) && majorVersion < 11) {
            highlightJs.configure({ useBR: false });
        }

        return true;
    }

    const syntaxEnabled = configureHighlightSyntax();

    const toaster = new ToastManager(elements.toastContainer);
    const storage = new StorageManager();
    const turndown = new TurndownServiceCtor({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
    });

    function escapeHtmlAttribute(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // Keep explicit image widths so resized images stay consistent across save/reload.
    turndown.addRule('resizedImagesToHtml', {
        filter(node) {
            if (!node || node.nodeName !== 'IMG') {
                return false;
            }

            const widthFromStyle = node.style?.width || '';
            const widthFromAttr = node.getAttribute('width') || '';
            return Boolean(widthFromStyle || widthFromAttr);
        },
        replacement(content, node) {
            const src = escapeHtmlAttribute(node.getAttribute('src') || '');
            const alt = escapeHtmlAttribute(node.getAttribute('alt') || '');
            const widthCandidate = node.style?.width || node.getAttribute('width') || '';
            const parsedWidth = parseInt(String(widthCandidate).replace('px', '').trim(), 10);
            const width = Number.isNaN(parsedWidth) || parsedWidth <= 0 ? '' : ` width="${parsedWidth}"`;

            return `<img src="${src}" alt="${alt}"${width} />`;
        }
    });

    let settings = loadSettings();
    let currentTheme = storage.load(THEME_KEY);
    let currentNotepadId = 'default';
    let currentNotepads = [];
    let isInitialLoad = true;
    let isSyncingEditor = false;
    let saveTimeout = null;
    let uploadsFilter = 'all';
    let uploadsCache = [];
    let uploadConfig = {
        maxUploadSizeMB: 10,
        maxUploadFiles: 6,
        acceptedExtensions: [],
        blockedExtensions: [],
    };
    const selectedUploadFilenames = new Set();
    let previewedUpload = null;
    const imageResizeState = {
        target: null,
        handle: null,
        leftHandle: null,
        rightHandle: null,
        toolbar: null,
        sizeLabel: null,
        activeHandleMode: 'corner',
        isResizing: false,
        startX: 0,
        startWidth: 0,
    };
    const fileDropState = {
        overlay: null,
        dragDepth: 0,
    };

    const quill = new QuillCtor(elements.editorRoot, {
        theme: 'snow',
        modules: {
            toolbar: [
                [{ header: [1, 2, 3, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                [{ list: 'ordered' }, { list: 'bullet' }],
                ['blockquote', 'code-block'],
                ['link', 'image'],
                ['clean']
            ],
            syntax: syntaxEnabled,
            history: {
                delay: 500,
                maxStack: 100,
                userOnly: true,
            }
        },
        placeholder: 'Type your note here...',
    });

    quill.on('text-change', (delta, oldDelta, source) => {
        if (source !== 'user' || isSyncingEditor) {
            return;
        }
        scheduleSave();
    });

    // Intercept clipboard files for local upload and direct insertion.
    quill.root.addEventListener('paste', async (event) => {
        const files = Array.from(event.clipboardData?.items || [])
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter(Boolean);

        if (files.length === 0) {
            return;
        }

        event.preventDefault();
        await uploadAndInsertFiles(files, 'paste');
    });

    const toolbar = quill.getModule('toolbar');
    toolbar.addHandler('image', () => {
        const imagePicker = document.createElement('input');
        imagePicker.type = 'file';
        imagePicker.accept = 'image/*';
        imagePicker.multiple = true;

        imagePicker.addEventListener('change', async (event) => {
            const files = Array.from(event.target.files || []);
            if (files.length === 0) {
                return;
            }
            await uploadAndInsertFiles(files, 'attach');
        });

        imagePicker.click();
    });

    setupImageResizeInteractions();
    setupFileDropInteractions();

    const searchManager = new SearchManager(fetchWithPin, selectNotepad, closeAllModals);

    function detectOS() {
        return /Macintosh|Mac OS X/i.test(navigator.userAgent);
    }

    function loadSettings() {
        const saved = storage.load(SETTINGS_KEY);
        return saved ? { ...settingsDefaults, ...saved } : { ...settingsDefaults };
    }

    function applySettingsToInputs() {
        elements.settingsInputAutoSaveStatusInterval.value = settings.saveStatusMessageInterval;
    }

    function saveSettingsFromInputs() {
        const interval = parseInt(elements.settingsInputAutoSaveStatusInterval.value, 10);
        settings.saveStatusMessageInterval = Number.isNaN(interval) || interval < 0
            ? settingsDefaults.saveStatusMessageInterval
            : interval;
        storage.save(SETTINGS_KEY, settings);
    }

    function updateUploadHelpText() {
        const allowedTypes = uploadConfig.acceptedExtensions.length > 0
            ? uploadConfig.acceptedExtensions.join(', ')
            : 'images, .pdf, .docx, .xlsx, .csv, .md';

        elements.attachFilesHelp.textContent = `Drag and drop, paste, or attach up to ${uploadConfig.maxUploadFiles} files (${uploadConfig.maxUploadSizeMB}MB each). Allowed: ${allowedTypes}. Click image to resize.`;
    }

    function updateUploadInputAccept() {
        if (!elements.attachFilesInput) {
            return;
        }

        const accepted = Array.isArray(uploadConfig.acceptedExtensions)
            ? uploadConfig.acceptedExtensions.filter(Boolean)
            : [];
        elements.attachFilesInput.setAttribute('accept', accepted.join(','));
    }

    function updateUploadsSelectionControls() {
        if (!elements.uploadsDeleteSelectedBtn) {
            return;
        }

        const selectedCount = selectedUploadFilenames.size;
        elements.uploadsDeleteSelectedBtn.textContent = `Delete selected (${selectedCount})`;
        elements.uploadsDeleteSelectedBtn.disabled = selectedCount === 0;
    }

    function toggleUploadSelection(filename, isSelected) {
        if (!filename) {
            return;
        }

        if (isSelected) {
            selectedUploadFilenames.add(filename);
        } else {
            selectedUploadFilenames.delete(filename);
        }

        updateUploadsSelectionControls();
    }

    function clearUploadSelection() {
        selectedUploadFilenames.clear();
        renderUploadsList();
    }

    function selectAllVisibleUploads() {
        const visibleFiles = getFilteredUploads();
        visibleFiles.forEach((file) => {
            if (file.filename) {
                selectedUploadFilenames.add(file.filename);
            }
        });
        renderUploadsList();
    }

    function openUploadPreview(file) {
        if (!file || !file.url || !elements.uploadPreviewModal) {
            return;
        }

        // Close other modals but keep preview modal state intact.
        document.querySelectorAll('.modal').forEach((modal) => {
            if (modal !== elements.uploadPreviewModal) {
                hideModal(modal);
            }
        });
        searchManager.closeModal();

        previewedUpload = file;
        const fileName = file.originalName || file.filename || 'file';
        elements.uploadPreviewTitle.textContent = `Preview: ${fileName}`;
        elements.uploadPreviewImage.hidden = true;
        elements.uploadPreviewFrame.hidden = true;

        if (file.isImage) {
            elements.uploadPreviewImage.src = file.url;
            elements.uploadPreviewImage.alt = fileName;
            elements.uploadPreviewImage.hidden = false;
            elements.uploadPreviewFrame.src = 'about:blank';
        } else {
            elements.uploadPreviewFrame.src = file.url;
            elements.uploadPreviewFrame.hidden = false;
            elements.uploadPreviewImage.removeAttribute('src');
        }

        elements.uploadPreviewModal.classList.add('visible');
        elements.uploadPreviewCloseBtn?.focus();
    }

    function closeUploadPreview() {
        if (!elements.uploadPreviewModal) {
            return;
        }

        elements.uploadPreviewFrame.src = 'about:blank';
        elements.uploadPreviewImage.removeAttribute('src');
        previewedUpload = null;
        hideModal(elements.uploadPreviewModal);
    }

    async function deleteSelectedUploads() {
        const selected = Array.from(selectedUploadFilenames).filter(Boolean);
        if (selected.length === 0) {
            toaster.show('Select files before deleting', 'error', false, 2200);
            return;
        }

        const shouldDelete = window.confirm(`Delete ${selected.length} selected file(s)?`);
        if (!shouldDelete) {
            return;
        }

        const failures = [];
        for (const filename of selected) {
            try {
                await deleteUpload(filename, { skipRender: true });
            } catch (error) {
                failures.push(filename);
            }
        }

        selectedUploadFilenames.clear();
        renderUploadsList();

        if (failures.length > 0) {
            toaster.show(`Deleted ${selected.length - failures.length}/${selected.length} files`, 'error', false, 3200);
            return;
        }

        toaster.show(`Deleted ${selected.length} files`, 'success');
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) {
            return '0 B';
        }

        const units = ['B', 'KB', 'MB', 'GB'];
        const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const value = bytes / (1024 ** exp);
        return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
    }

    function formatUploadDate(value) {
        if (!value) {
            return '';
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return '';
        }

        return date.toLocaleString();
    }

    function getFilteredUploads() {
        if (uploadsFilter === 'image') {
            return uploadsCache.filter((file) => file.isImage);
        }

        if (uploadsFilter === 'file') {
            return uploadsCache.filter((file) => !file.isImage);
        }

        return uploadsCache;
    }

    function updateUploadsTabState() {
        elements.uploadsTabs.forEach((button) => {
            const isActive = button.dataset.filter === uploadsFilter;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
    }

    function createUploadActionButton(label, className, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `upload-action-button ${className || ''}`.trim();
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    function renderUploadsList() {
        if (!elements.uploadsList) {
            return;
        }

        const validFilenames = new Set(uploadsCache.map((file) => file.filename));
        Array.from(selectedUploadFilenames).forEach((filename) => {
            if (!validFilenames.has(filename)) {
                selectedUploadFilenames.delete(filename);
            }
        });

        updateUploadsTabState();
        elements.uploadsList.innerHTML = '';

        const files = getFilteredUploads();
        if (files.length === 0) {
            const emptyState = document.createElement('li');
            emptyState.className = 'uploads-empty';
            emptyState.textContent = 'No uploads in this filter.';
            elements.uploadsList.appendChild(emptyState);
            updateUploadsSelectionControls();
            return;
        }

        files.forEach((file) => {
            const item = document.createElement('li');
            item.className = 'upload-item';
            const isSelected = selectedUploadFilenames.has(file.filename);
            item.classList.toggle('selected', isSelected);
            item.draggable = true;
            item.setAttribute('role', 'button');
            item.setAttribute('aria-label', `Drag ${file.originalName || file.filename || 'file'} into editor`);

            item.addEventListener('dragstart', (event) => {
                if (!event.dataTransfer) {
                    return;
                }

                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData('application/x-dumbpad-upload', JSON.stringify(file));
                event.dataTransfer.setData('text/uri-list', file.url || '');
                event.dataTransfer.setData('text/plain', file.originalName || file.filename || file.url || '');
            });

            const titleRow = document.createElement('div');
            titleRow.className = 'upload-title-row';

            const selectCheckbox = document.createElement('input');
            selectCheckbox.type = 'checkbox';
            selectCheckbox.className = 'upload-select-checkbox';
            selectCheckbox.checked = isSelected;
            selectCheckbox.setAttribute('aria-label', `Select ${file.originalName || file.filename || 'file'}`);
            selectCheckbox.addEventListener('click', (event) => {
                event.stopPropagation();
            });
            selectCheckbox.addEventListener('change', (event) => {
                event.stopPropagation();
                toggleUploadSelection(file.filename, event.target.checked);
                item.classList.toggle('selected', event.target.checked);
            });

            const name = document.createElement('div');
            name.className = 'upload-name';
            name.textContent = file.originalName || file.filename || 'file';

            titleRow.appendChild(selectCheckbox);
            titleRow.appendChild(name);

            const meta = document.createElement('div');
            meta.className = 'upload-meta';
            const dateLabel = formatUploadDate(file.modifiedAt);
            meta.textContent = `${formatBytes(file.size)}${dateLabel ? ` - ${dateLabel}` : ''}`;

            const actions = document.createElement('div');
            actions.className = 'upload-actions';

            const previewButton = createUploadActionButton('Preview', '', () => {
                openUploadPreview(file);
            });

            const downloadButton = createUploadActionButton('Download', '', () => {
                const link = document.createElement('a');
                link.href = file.url;
                link.download = file.originalName || file.filename || 'download';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            });

            const deleteButton = createUploadActionButton('Delete', 'delete', async () => {
                const shouldDelete = window.confirm(`Delete '${file.originalName || file.filename || 'file'}'?`);
                if (!shouldDelete) {
                    return;
                }

                try {
                    await deleteUpload(file.filename);
                    toaster.show('Upload deleted', 'success');
                } catch (error) {
                    toaster.show(error.message || 'Failed to delete upload', 'error', false, 3000);
                }
            });

            actions.appendChild(previewButton);
            actions.appendChild(downloadButton);
            actions.appendChild(deleteButton);

            item.appendChild(titleRow);
            item.appendChild(meta);
            item.appendChild(actions);
            elements.uploadsList.appendChild(item);
        });

        updateUploadsSelectionControls();
    }

    async function loadUploads() {
        const response = await fetchWithPin('/api/uploads/list');
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(payload.error || 'Failed to load uploads');
        }

        uploadsCache = Array.isArray(payload.files) ? payload.files : [];

        if (payload.uploadConfig) {
            uploadConfig = {
                maxUploadSizeMB: payload.uploadConfig.maxUploadSizeMB || uploadConfig.maxUploadSizeMB,
                maxUploadFiles: payload.uploadConfig.maxUploadFiles || uploadConfig.maxUploadFiles,
                acceptedExtensions: Array.isArray(payload.uploadConfig.acceptedExtensions)
                    ? payload.uploadConfig.acceptedExtensions
                    : uploadConfig.acceptedExtensions,
                blockedExtensions: Array.isArray(payload.uploadConfig.blockedExtensions)
                    ? payload.uploadConfig.blockedExtensions
                    : uploadConfig.blockedExtensions,
            };
            updateUploadHelpText();
            updateUploadInputAccept();
        }

        renderUploadsList();
    }

    async function deleteUpload(filename, options = {}) {
        const { skipRender = false } = options;

        if (!filename) {
            throw new Error('Invalid upload file');
        }

        const response = await fetchWithPin(`/api/uploads/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || 'Delete failed');
        }

        uploadsCache = uploadsCache.filter((file) => file.filename !== filename);
        selectedUploadFilenames.delete(filename);
        if (!skipRender) {
            renderUploadsList();
        }
    }

    function clearSelectedImage() {
        if (imageResizeState.target) {
            imageResizeState.target.classList.remove('is-resizable-selected');
        }

        imageResizeState.target = null;
        if (imageResizeState.handle) {
            imageResizeState.handle.classList.remove('visible');
        }
        if (imageResizeState.leftHandle) {
            imageResizeState.leftHandle.classList.remove('visible');
        }
        if (imageResizeState.rightHandle) {
            imageResizeState.rightHandle.classList.remove('visible');
        }
        if (imageResizeState.toolbar) {
            imageResizeState.toolbar.classList.remove('visible');
        }
    }

    function updateResizeSizeLabel() {
        if (!imageResizeState.target || !imageResizeState.sizeLabel) {
            return;
        }

        const width = Math.round(imageResizeState.target.getBoundingClientRect().width);
        imageResizeState.sizeLabel.textContent = `${width}px`;
    }

    function applyImageWidth(widthPx) {
        if (!imageResizeState.target) {
            return;
        }

        const maxWidth = Math.max(80, quill.root.clientWidth - 16);
        const nextWidth = Math.max(80, Math.min(maxWidth, Math.round(widthPx)));
        imageResizeState.target.style.width = `${nextWidth}px`;
        imageResizeState.target.style.maxWidth = 'none';
        imageResizeState.target.style.height = 'auto';
        positionResizeHandle();
        updateResizeSizeLabel();
    }

    function applyImageRatio(ratio) {
        const maxWidth = Math.max(80, quill.root.clientWidth - 16);
        applyImageWidth(maxWidth * ratio);
        scheduleSave();
    }

    function resetImageSize() {
        if (!imageResizeState.target) {
            return;
        }

        imageResizeState.target.style.removeProperty('width');
        imageResizeState.target.style.removeProperty('max-width');
        imageResizeState.target.style.removeProperty('height');
        positionResizeHandle();
        updateResizeSizeLabel();
        scheduleSave();
    }

    function positionResizeHandle() {
        if (!imageResizeState.target || !imageResizeState.handle || !quill.root.contains(imageResizeState.target)) {
            clearSelectedImage();
            return;
        }

        const imageRect = imageResizeState.target.getBoundingClientRect();
        const containerRect = quill.container.getBoundingClientRect();

        imageResizeState.handle.style.left = `${imageRect.right - containerRect.left - 9}px`;
        imageResizeState.handle.style.top = `${imageRect.bottom - containerRect.top - 9}px`;
        imageResizeState.handle.classList.add('visible');

        const midY = imageRect.top - containerRect.top + (imageRect.height / 2) - 16;

        if (imageResizeState.leftHandle) {
            imageResizeState.leftHandle.style.left = `${imageRect.left - containerRect.left - 6}px`;
            imageResizeState.leftHandle.style.top = `${midY}px`;
            imageResizeState.leftHandle.classList.add('visible');
        }

        if (imageResizeState.rightHandle) {
            imageResizeState.rightHandle.style.left = `${imageRect.right - containerRect.left - 6}px`;
            imageResizeState.rightHandle.style.top = `${midY}px`;
            imageResizeState.rightHandle.classList.add('visible');
        }

        if (imageResizeState.toolbar) {
            const editorPadding = 8;
            const toolbarWidth = imageResizeState.toolbar.offsetWidth || 220;
            const leftRaw = imageRect.left - containerRect.left;
            const maxLeft = Math.max(editorPadding, quill.container.clientWidth - toolbarWidth - editorPadding);
            const toolbarLeft = Math.max(editorPadding, Math.min(maxLeft, leftRaw));

            let toolbarTop = imageRect.top - containerRect.top - 42;
            if (toolbarTop < editorPadding) {
                toolbarTop = imageRect.bottom - containerRect.top + 10;
            }

            imageResizeState.toolbar.style.left = `${toolbarLeft}px`;
            imageResizeState.toolbar.style.top = `${toolbarTop}px`;
            imageResizeState.toolbar.classList.add('visible');
            updateResizeSizeLabel();
        }
    }

    function selectResizableImage(imageElement) {
        if (!imageElement || imageElement.tagName !== 'IMG') {
            clearSelectedImage();
            return;
        }

        if (imageResizeState.target && imageResizeState.target !== imageElement) {
            imageResizeState.target.classList.remove('is-resizable-selected');
        }

        imageResizeState.target = imageElement;
        imageElement.classList.add('is-resizable-selected');
        positionResizeHandle();
    }

    function onImageResizeMove(event) {
        if (!imageResizeState.isResizing || !imageResizeState.target) {
            return;
        }

        const deltaX = event.clientX - imageResizeState.startX;
        const direction = imageResizeState.activeHandleMode === 'left' ? -1 : 1;
        applyImageWidth(imageResizeState.startWidth + (deltaX * direction));
    }

    function onImageResizeStop() {
        if (!imageResizeState.isResizing) {
            return;
        }

        imageResizeState.isResizing = false;
        document.removeEventListener('mousemove', onImageResizeMove);
        document.removeEventListener('mouseup', onImageResizeStop);
        scheduleSave();
    }

    function beginImageResize(event, mode = 'corner') {
        if (!imageResizeState.target) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        imageResizeState.isResizing = true;
        imageResizeState.activeHandleMode = mode;
        imageResizeState.startX = event.clientX;
        imageResizeState.startWidth = imageResizeState.target.getBoundingClientRect().width;

        document.addEventListener('mousemove', onImageResizeMove);
        document.addEventListener('mouseup', onImageResizeStop);
    }

    function setupImageResizeInteractions() {
        const handle = document.createElement('div');
        handle.className = 'ql-image-resize-handle';
        handle.setAttribute('role', 'presentation');
        quill.container.appendChild(handle);

        const leftHandle = document.createElement('div');
        leftHandle.className = 'ql-image-resize-edge-handle left';
        leftHandle.setAttribute('role', 'presentation');
        quill.container.appendChild(leftHandle);

        const rightHandle = document.createElement('div');
        rightHandle.className = 'ql-image-resize-edge-handle right';
        rightHandle.setAttribute('role', 'presentation');
        quill.container.appendChild(rightHandle);

        const toolbar = document.createElement('div');
        toolbar.className = 'ql-image-resize-toolbar';

        const label = document.createElement('span');
        label.className = 'ql-image-size-label';
        label.textContent = '0px';
        toolbar.appendChild(label);

        const presets = [
            { label: 'S', ratio: 0.35 },
            { label: 'M', ratio: 0.5 },
            { label: 'L', ratio: 0.75 },
            { label: 'Full', ratio: 1 },
        ];

        presets.forEach((preset) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ql-image-size-button';
            button.textContent = preset.label;
            button.addEventListener('click', () => applyImageRatio(preset.ratio));
            toolbar.appendChild(button);
        });

        const resetButton = document.createElement('button');
        resetButton.type = 'button';
        resetButton.className = 'ql-image-size-button reset';
        resetButton.textContent = 'Auto';
        resetButton.addEventListener('click', resetImageSize);
        toolbar.appendChild(resetButton);

        const dragHint = document.createElement('span');
        dragHint.className = 'ql-image-size-hint';
        dragHint.textContent = 'Drag edge/corner';
        toolbar.appendChild(dragHint);

        quill.container.appendChild(toolbar);

        imageResizeState.handle = handle;
        imageResizeState.leftHandle = leftHandle;
        imageResizeState.rightHandle = rightHandle;
        imageResizeState.toolbar = toolbar;
        imageResizeState.sizeLabel = label;
        imageResizeState.handle.addEventListener('mousedown', (event) => beginImageResize(event, 'corner'));
        imageResizeState.leftHandle.addEventListener('mousedown', (event) => beginImageResize(event, 'left'));
        imageResizeState.rightHandle.addEventListener('mousedown', (event) => beginImageResize(event, 'right'));

        quill.root.addEventListener('click', (event) => {
            const image = event.target.closest('img');
            if (image) {
                selectResizableImage(image);
            } else if (!imageResizeState.isResizing) {
                clearSelectedImage();
            }
        });

        quill.root.addEventListener('scroll', positionResizeHandle, true);
        window.addEventListener('resize', positionResizeHandle);

        document.addEventListener('click', (event) => {
            if (
                quill.root.contains(event.target)
                || imageResizeState.toolbar?.contains(event.target)
                || imageResizeState.handle?.contains(event.target)
                || imageResizeState.leftHandle?.contains(event.target)
                || imageResizeState.rightHandle?.contains(event.target)
            ) {
                return;
            }

            if (!imageResizeState.isResizing) {
                clearSelectedImage();
            }
        });

        quill.on('selection-change', () => {
            if (!imageResizeState.target || imageResizeState.isResizing) {
                return;
            }
            positionResizeHandle();
        });
    }

    function isFileDragEvent(event) {
        const types = Array.from(event.dataTransfer?.types || []);
        return types.includes('Files');
    }

    function isUploadItemDragEvent(event) {
        const types = Array.from(event.dataTransfer?.types || []);
        return types.includes('application/x-dumbpad-upload');
    }

    function isSupportedDropEvent(event) {
        return isFileDragEvent(event) || isUploadItemDragEvent(event);
    }

    function getDraggedUploadFromEvent(event) {
        try {
            const raw = event.dataTransfer?.getData('application/x-dumbpad-upload') || '';
            if (!raw) {
                return null;
            }

            const parsed = JSON.parse(raw);
            if (!parsed || !parsed.url) {
                return null;
            }

            return parsed;
        } catch (error) {
            return null;
        }
    }

    function showDropOverlay() {
        if (!fileDropState.overlay) {
            return;
        }

        fileDropState.overlay.classList.add('visible');
    }

    function hideDropOverlay() {
        if (!fileDropState.overlay) {
            return;
        }

        fileDropState.overlay.classList.remove('visible');
    }

    function setupFileDropInteractions() {
        const overlay = document.createElement('div');
        overlay.className = 'editor-drop-overlay';
        overlay.textContent = 'Drop files to upload';
        quill.container.appendChild(overlay);

        fileDropState.overlay = overlay;

        quill.container.addEventListener('dragenter', (event) => {
            if (!isSupportedDropEvent(event)) {
                return;
            }

            event.preventDefault();
            fileDropState.dragDepth += 1;
            showDropOverlay();
        });

        quill.container.addEventListener('dragover', (event) => {
            if (!isSupportedDropEvent(event)) {
                return;
            }

            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            showDropOverlay();
        });

        quill.container.addEventListener('dragleave', (event) => {
            if (!isSupportedDropEvent(event)) {
                return;
            }

            event.preventDefault();
            fileDropState.dragDepth = Math.max(0, fileDropState.dragDepth - 1);
            if (fileDropState.dragDepth === 0) {
                hideDropOverlay();
            }
        });

        quill.container.addEventListener('drop', async (event) => {
            if (!isSupportedDropEvent(event)) {
                return;
            }

            event.preventDefault();
            fileDropState.dragDepth = 0;
            hideDropOverlay();

            quill.focus();

            const files = Array.from(event.dataTransfer?.files || []);
            if (files.length > 0) {
                await uploadAndInsertFiles(files, 'drop');
                return;
            }

            const draggedUpload = getDraggedUploadFromEvent(event);
            if (!draggedUpload) {
                return;
            }

            insertUploadedFiles([draggedUpload]);
            scheduleSave();
            toaster.show('Inserted 1 uploaded item', 'success', false, 1800);
        });

        document.addEventListener('dragend', () => {
            fileDropState.dragDepth = 0;
            hideDropOverlay();
        });

        document.addEventListener('drop', () => {
            fileDropState.dragDepth = 0;
            hideDropOverlay();
        });
    }

    function getEditorHtml() {
        const html = quill.root.innerHTML;
        return html === '<p><br></p>' ? '' : html;
    }

    function getMarkdown() {
        const html = getEditorHtml();
        return html ? turndown.turndown(html) : '';
    }

    function setMarkdown(markdownText) {
        const markdown = markdownText || '';
        const html = markdown ? marked.parse(markdown) : '';

        clearSelectedImage();
        isSyncingEditor = true;
        quill.setContents([], 'silent');
        if (html.trim()) {
            quill.clipboard.dangerouslyPasteHTML(0, html, 'silent');
        }
        if (!html.trim()) {
            quill.setText('', 'silent');
        }
        isSyncingEditor = false;
    }

    async function fetchWithPin(url, options = {}) {
        options.credentials = 'same-origin';
        return fetch(url, options);
    }

    async function uploadFiles(fileList) {
        const files = Array.from(fileList || []);
        if (files.length === 0) {
            return [];
        }

        const limitedFiles = files.slice(0, uploadConfig.maxUploadFiles);
        if (limitedFiles.length < files.length) {
            toaster.show(`Only the first ${uploadConfig.maxUploadFiles} files will be uploaded`, 'error', false, 2500);
        }

        const formData = new FormData();
        limitedFiles.forEach((file) => {
            formData.append('files', file, file.name || 'file');
        });

        const response = await fetchWithPin('/api/uploads', {
            method: 'POST',
            body: formData,
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || 'Upload failed');
        }

        if (payload.uploadConfig) {
            uploadConfig = {
                maxUploadSizeMB: payload.uploadConfig.maxUploadSizeMB || uploadConfig.maxUploadSizeMB,
                maxUploadFiles: payload.uploadConfig.maxUploadFiles || uploadConfig.maxUploadFiles,
                acceptedExtensions: Array.isArray(payload.uploadConfig.acceptedExtensions)
                    ? payload.uploadConfig.acceptedExtensions
                    : uploadConfig.acceptedExtensions,
                blockedExtensions: Array.isArray(payload.uploadConfig.blockedExtensions)
                    ? payload.uploadConfig.blockedExtensions
                    : uploadConfig.blockedExtensions,
            };
            updateUploadHelpText();
            updateUploadInputAccept();
        }

        return Array.isArray(payload.files) ? payload.files : [];
    }

    function insertUploadedFiles(uploadedFiles) {
        if (!uploadedFiles || uploadedFiles.length === 0) {
            return;
        }

        const currentSelection = quill.getSelection(true);
        let insertIndex = currentSelection ? currentSelection.index : quill.getLength();

        uploadedFiles.forEach((file) => {
            const fileName = file.originalName || file.filename || 'file';

            if (file.isImage) {
                quill.insertEmbed(insertIndex, 'image', file.url, 'user');
                insertIndex += 1;
                quill.insertText(insertIndex, '\n', 'user');
                insertIndex += 1;
                return;
            }

            quill.insertText(insertIndex, fileName, { link: file.url }, 'user');
            insertIndex += fileName.length;
            quill.insertText(insertIndex, '\n', 'user');
            insertIndex += 1;
        });

        quill.setSelection(insertIndex, 0, 'silent');
    }

    async function uploadAndInsertFiles(fileList, source = 'attach') {
        try {
            const uploadedFiles = await uploadFiles(fileList);
            insertUploadedFiles(uploadedFiles);
            await loadUploads();
            scheduleSave();

            const label = source === 'paste'
                ? 'Pasted'
                : source === 'drop'
                    ? 'Dropped'
                    : 'Attached';
            toaster.show(`${label} ${uploadedFiles.length} file(s)`, 'success');
        } catch (error) {
            console.error('Upload failed:', error);
            toaster.show(error.message || 'Failed to upload file(s)', 'error', false, 3500);
        }
    }

    function updateUrlWithNotepad(notepadName) {
        if (!notepadName) {
            return;
        }
        const url = new URL(window.location.href);
        url.searchParams.set('id', notepadName);
        window.history.pushState({ notepadName }, '', url.toString());
    }

    function resolveSelectedNotepad(notepadsList, fallbackId) {
        if (!isInitialLoad) {
            return fallbackId;
        }

        const requested = new URLSearchParams(window.location.search).get('id');
        if (!requested) {
            return fallbackId;
        }

        const found = notepadsList.find((pad) =>
            pad.id === requested || pad.name.toLowerCase() === requested.toLowerCase()
        );

        if (!found) {
            toaster.show(`Notepad '${requested}' not found`, 'error');
            return fallbackId;
        }

        return found.id;
    }

    async function loadConfig() {
        const response = await fetchWithPin('/api/config');
        const config = await response.json();

        if (config.error) {
            throw new Error(config.error);
        }

        if (config.uploadConfig) {
            uploadConfig = {
                maxUploadSizeMB: config.uploadConfig.maxUploadSizeMB || uploadConfig.maxUploadSizeMB,
                maxUploadFiles: config.uploadConfig.maxUploadFiles || uploadConfig.maxUploadFiles,
                acceptedExtensions: Array.isArray(config.uploadConfig.acceptedExtensions)
                    ? config.uploadConfig.acceptedExtensions
                    : uploadConfig.acceptedExtensions,
                blockedExtensions: Array.isArray(config.uploadConfig.blockedExtensions)
                    ? config.uploadConfig.blockedExtensions
                    : uploadConfig.blockedExtensions,
            };
        }

        elements.pageTitle.textContent = config.siteTitle;
        elements.headerTitle.textContent = config.siteTitle;
        elements.headerTitle.setAttribute('data-tooltip', `Version: ${config.version}`);
        updateUploadHelpText();
        updateUploadInputAccept();
        renderUploadsList();
    }

    async function loadNotepads() {
        const response = await fetchWithPin('/api/notepads');
        const data = await response.json();

        currentNotepads = data.notepads_list || [];
        currentNotepadId = resolveSelectedNotepad(currentNotepads, data.note_history || 'default');

        elements.notepadSelector.innerHTML = currentNotepads
            .map((pad) => `<option value="${pad.id}"${pad.id === currentNotepadId ? ' selected' : ''}>${pad.name}</option>`)
            .join('');
    }

    async function loadNotes(notepadId) {
        const response = await fetchWithPin(`/api/notes/${notepadId}`);
        const data = await response.json();
        setMarkdown(data.content || '');
    }

    async function saveNotes(showStatus = false) {
        const content = getMarkdown();
        await fetchWithPin(`/api/notes/${currentNotepadId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ content }),
        });

        if (showStatus) {
            toaster.show('Saved', 'success', false, settings.saveStatusMessageInterval);
        }
    }

    function scheduleSave() {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(async () => {
            try {
                await saveNotes(true);
            } catch (error) {
                console.error('Save failed:', error);
                toaster.show('Error saving', 'error', false, 3000);
            }
        }, 350);
    }

    async function selectNotepad(id) {
        if (!id) {
            return;
        }

        currentNotepadId = id;
        elements.notepadSelector.value = id;
        await loadNotes(id);

        const selectedOption = elements.notepadSelector.options[elements.notepadSelector.selectedIndex];
        if (selectedOption) {
            updateUrlWithNotepad(selectedOption.text);
        }
    }

    async function createNotepad() {
        try {
            const response = await fetchWithPin('/api/notepads', { method: 'POST' });
            const created = await response.json();
            await loadNotepads();
            await selectNotepad(created.id);
            toaster.show(`New notepad: ${created.name}`, 'success');
        } catch (error) {
            console.error('Create notepad failed:', error);
            toaster.show('Error creating notepad', 'error', false, 3000);
        }
    }

    async function renameNotepad(newName) {
        const response = await fetchWithPin(`/api/notepads/${currentNotepadId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: newName }),
        });

        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.error || 'Rename failed');
        }

        await loadNotepads();
        elements.notepadSelector.value = currentNotepadId;

        if (payload.name !== newName) {
            toaster.show(`Name changed to '${payload.name}' for uniqueness`, 'success', false, 2500);
        } else {
            toaster.show('Renamed notepad', 'success');
        }

        updateUrlWithNotepad(payload.name);
    }

    async function deleteNotepad() {
        if (currentNotepadId === 'default') {
            toaster.show('Cannot delete default notepad', 'error', false, 2500);
            return;
        }

        const response = await fetchWithPin(`/api/notepads/${currentNotepadId}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || 'Delete failed');
        }

        await loadNotepads();
        const nextId = currentNotepads[0]?.id || 'default';
        await selectNotepad(nextId);
        toaster.show('Notepad deleted', 'success');
    }

    function downloadContent(extension) {
        const selectedName = elements.notepadSelector.options[elements.notepadSelector.selectedIndex]?.text || 'note';
        const baseName = selectedName.includes('.')
            ? selectedName.substring(0, selectedName.lastIndexOf('.'))
            : selectedName;

        const markdown = getMarkdown();
        const output = extension === 'txt' ? markdown : markdown;

        const blob = new Blob([output], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${baseName}.${extension}`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
    }

    function exportMarkdown() {
        downloadContent('md');
        toaster.show('Markdown exported', 'success');
    }

    function printCurrentNote() {
        const markdown = getMarkdown();
        const html = marked.parse(markdown);
        const printWindow = window.open('', '_blank');

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Print Notepad</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 2rem; line-height: 1.6; }
                    img { max-width: 100%; height: auto; }
                    pre { background: #f2f4f7; padding: 0.75rem; border-radius: 8px; overflow-x: auto; }
                    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
                </style>
            </head>
            <body>${html}</body>
            </html>
        `);

        printWindow.document.close();
        printWindow.focus();
        setTimeout(() => {
            printWindow.print();
            printWindow.close();
        }, 250);
    }

    async function copyCurrentNotepadLink() {
        try {
            await navigator.clipboard.writeText(window.location.href);
            toaster.show('Link copied to clipboard', 'success');
        } catch (error) {
            toaster.show('Failed to copy link', 'error', false, 2500);
        }
    }

    function hideModal(modal) {
        modal.classList.remove('visible');
    }

    function showModal(modal, focusElement) {
        closeAllModals();
        modal.classList.add('visible');
        if (focusElement) {
            focusElement.focus();
        }
    }

    function closeAllModals() {
        closeUploadPreview();
        document.querySelectorAll('.modal').forEach((modal) => hideModal(modal));
        searchManager.closeModal();
    }

    function setupTooltips() {
        const isMobile = window.matchMedia('(max-width: 585px)').matches || window.matchMedia('(pointer: coarse)').matches;
        if (isMobile) {
            return;
        }

        const isMac = detectOS();
        elements.tooltips.forEach((element) => {
            let tooltipText = element.getAttribute('data-tooltip');
            const shortcutsString = element.getAttribute('data-shortcuts');

            if (tooltipText && shortcutsString) {
                try {
                    const shortcuts = JSON.parse(shortcutsString);
                    const replacement = isMac ? shortcuts.mac : shortcuts.win;
                    if (replacement) {
                        tooltipText = tooltipText.replace('{shortcut}', replacement);
                        element.setAttribute('data-tooltip', tooltipText);
                    }
                } catch (error) {
                    console.error('Error parsing shortcuts:', error);
                }
            }

            const tooltip = document.createElement('div');
            tooltip.classList.add('tooltip');
            document.body.appendChild(tooltip);

            element.addEventListener('mouseover', (event) => {
                tooltip.textContent = element.getAttribute('data-tooltip');
                tooltip.style.left = `${event.pageX + 10}px`;
                tooltip.style.top = `${event.pageY + 10}px`;
                tooltip.classList.add('show');
            });

            element.addEventListener('mouseout', () => {
                tooltip.classList.remove('show');
            });
        });
    }

    function toggleTheme() {
        currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', currentTheme);
        storage.save(THEME_KEY, currentTheme);
    }

    function addEventListeners() {
        elements.copyLinkBtn.addEventListener('click', copyCurrentNotepadLink);
        elements.themeToggle.addEventListener('click', toggleTheme);

        elements.newNotepadBtn.addEventListener('click', createNotepad);
        elements.quickCreateNoteButton.addEventListener('click', createNotepad);

        elements.attachFilesButton.addEventListener('click', () => elements.attachFilesInput.click());
        elements.attachFilesInput.addEventListener('change', async (event) => {
            await uploadAndInsertFiles(event.target.files, 'attach');
            event.target.value = '';
        });

        elements.uploadsTabs.forEach((button) => {
            button.addEventListener('click', () => {
                uploadsFilter = button.dataset.filter || 'all';
                renderUploadsList();
            });
        });

        elements.uploadsSelectAllBtn.addEventListener('click', selectAllVisibleUploads);
        elements.uploadsClearSelectionBtn.addEventListener('click', clearUploadSelection);
        elements.uploadsDeleteSelectedBtn.addEventListener('click', deleteSelectedUploads);

        elements.uploadPreviewCloseBtn.addEventListener('click', closeUploadPreview);
        elements.uploadPreviewDownloadBtn.addEventListener('click', () => {
            if (!previewedUpload?.url) {
                return;
            }

            const link = document.createElement('a');
            link.href = previewedUpload.url;
            link.download = previewedUpload.originalName || previewedUpload.filename || 'download';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });

        elements.notepadSelector.addEventListener('change', async (event) => {
            await selectNotepad(event.target.value);
        });

        elements.renameNotepadBtn.addEventListener('click', () => {
            const currentName = elements.notepadSelector.options[elements.notepadSelector.selectedIndex]?.text || '';
            elements.renameInput.value = currentName;
            showModal(elements.renameModal, elements.renameInput);
        });

        elements.renameCancel.addEventListener('click', () => hideModal(elements.renameModal));
        elements.renameConfirm.addEventListener('click', async () => {
            const newName = elements.renameInput.value.trim();
            if (!newName) {
                return;
            }
            try {
                await renameNotepad(newName);
                hideModal(elements.renameModal);
            } catch (error) {
                toaster.show(error.message || 'Rename failed', 'error', false, 3000);
            }
        });

        elements.renameInput.addEventListener('keyup', (event) => {
            if (event.key === 'Enter') {
                elements.renameConfirm.click();
            }
        });

        elements.deleteNotepadBtn.addEventListener('click', () => {
            if (currentNotepadId === 'default') {
                toaster.show('Cannot delete default notepad', 'error', false, 2500);
                return;
            }
            showModal(elements.deleteModal, elements.deleteCancel);
        });

        elements.deleteCancel.addEventListener('click', () => hideModal(elements.deleteModal));
        elements.deleteConfirm.addEventListener('click', async () => {
            try {
                await deleteNotepad();
                hideModal(elements.deleteModal);
            } catch (error) {
                toaster.show(error.message || 'Delete failed', 'error', false, 3000);
            }
        });

        elements.downloadNotepadBtn.addEventListener('click', () => showModal(elements.downloadModal, elements.downloadCancel));
        elements.downloadCancel.addEventListener('click', () => hideModal(elements.downloadModal));

        elements.downloadTxt.addEventListener('click', () => {
            downloadContent('txt');
            hideModal(elements.downloadModal);
        });

        elements.downloadMd.addEventListener('click', () => {
            downloadContent('md');
            hideModal(elements.downloadModal);
        });

        elements.printNotepadBtn.addEventListener('click', printCurrentNote);
        elements.exportMarkdownBtn.addEventListener('click', exportMarkdown);

        elements.settingsBtn.addEventListener('click', () => {
            applySettingsToInputs();
            showModal(elements.settingsModal, elements.settingsInputAutoSaveStatusInterval);
        });

        elements.settingsCancel.addEventListener('click', () => hideModal(elements.settingsModal));
        elements.settingsSave.addEventListener('click', () => {
            saveSettingsFromInputs();
            hideModal(elements.settingsModal);
            toaster.show('Settings saved', 'success');
        });

        elements.settingsReset.addEventListener('click', () => {
            settings = { ...settingsDefaults };
            storage.save(SETTINGS_KEY, settings);
            applySettingsToInputs();
            hideModal(elements.settingsModal);
            toaster.show('Settings reset', 'success');
        });

        document.addEventListener('keydown', async (event) => {
            if (event.key === 'Escape') {
                closeAllModals();
            }

            const windowsModifier = event.ctrlKey;
            const macModifier = event.metaKey;

            if ((windowsModifier && event.altKey) || (macModifier && event.ctrlKey)) {
                switch (event.key) {
                    case 'n':
                        event.preventDefault();
                        createNotepad();
                        break;
                    case 'r':
                        event.preventDefault();
                        elements.renameNotepadBtn.click();
                        break;
                    case 'a':
                        event.preventDefault();
                        elements.downloadNotepadBtn.click();
                        break;
                    case 'm':
                        event.preventDefault();
                        exportMarkdown();
                        break;
                    case 'x':
                        event.preventDefault();
                        elements.deleteNotepadBtn.click();
                        break;
                    default:
                        break;
                }
            } else if (windowsModifier || macModifier) {
                switch (event.key) {
                    case 's':
                        event.preventDefault();
                        await saveNotes(true);
                        break;
                    case 'p':
                        event.preventDefault();
                        printCurrentNote();
                        break;
                    case 'k':
                        event.preventDefault();
                        searchManager.openModal();
                        break;
                    default:
                        break;
                }
            }
        });

        window.addEventListener('popstate', async () => {
            const requested = new URLSearchParams(window.location.search).get('id');
            if (!requested || currentNotepads.length === 0) {
                return;
            }

            const found = currentNotepads.find((pad) =>
                pad.id === requested || pad.name.toLowerCase() === requested.toLowerCase()
            );

            if (found && found.id !== currentNotepadId) {
                await selectNotepad(found.id);
            }
        });

        searchManager.addEventListeners();
    }

    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) {
            return;
        }

        try {
            await navigator.serviceWorker.register('/service-worker.js');
        } catch (error) {
            console.error('Service worker registration failed:', error);
        }
    }

    async function initialize() {
        try {
            setupTooltips();
            applySettingsToInputs();
            addEventListeners();
            await loadConfig();
            try {
                await loadUploads();
            } catch (error) {
                console.error('Failed to load uploads:', error);
                toaster.show('Unable to load uploads list', 'error', false, 2500);
            }
            await loadNotepads();

            if (currentNotepads.some((pad) => pad.id === currentNotepadId)) {
                await selectNotepad(currentNotepadId);
            } else if (currentNotepads.length > 0) {
                await selectNotepad(currentNotepads[0].id);
            } else {
                setMarkdown('');
            }

            if (!new URLSearchParams(window.location.search).has('id')) {
                const current = currentNotepads.find((pad) => pad.id === currentNotepadId);
                if (current) {
                    updateUrlWithNotepad(current.name);
                }
            }

            isInitialLoad = false;
            await registerServiceWorker();
        } catch (error) {
            console.error('Initialization failed:', error);
            toaster.show(error.message || 'Failed to initialize app', 'error', true, 5000);
        }
    }

    initialize();
});
