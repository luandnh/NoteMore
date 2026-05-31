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

    if (!QuillCtor || !TurndownServiceCtor) {
        const fallbackToaster = new ToastManager(elements.toastContainer);
        fallbackToaster.show('Editor library failed to load', 'error', true, 5000);
        return;
    }

    const toaster = new ToastManager(elements.toastContainer);
    const storage = new StorageManager();
    const turndown = new TurndownServiceCtor({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
    });

    let settings = loadSettings();
    let currentTheme = storage.load(THEME_KEY);
    let currentNotepadId = 'default';
    let currentNotepads = [];
    let isInitialLoad = true;
    let isSyncingEditor = false;
    let saveTimeout = null;
    let uploadConfig = {
        maxUploadSizeMB: 10,
        maxUploadFiles: 6,
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
        elements.attachFilesHelp.textContent = `Paste images/files into editor, or attach up to ${uploadConfig.maxUploadFiles} files (${uploadConfig.maxUploadSizeMB}MB each).`;
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
            };
            updateUploadHelpText();
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
            scheduleSave();

            const label = source === 'paste' ? 'Pasted' : 'Attached';
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
            };
        }

        elements.pageTitle.textContent = config.siteTitle;
        elements.headerTitle.textContent = config.siteTitle;
        elements.headerTitle.setAttribute('data-tooltip', `Version: ${config.version}`);
        updateUploadHelpText();
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
