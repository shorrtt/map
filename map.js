/* map.js — lean, no preloading, no crafting, no prodigy */

// Initialize the map with the canvas renderer for better performance
const map = L.map("map", {
  crs: L.CRS.Simple,
  minZoom: -15,
  zoom: 3,
  maxZoom: 10,
  preferCanvas: true,
});

// Set map bounds and add the base image overlay
const bounds = [
  [0, 0],
  [1000, 1000],
];
// Use an optimized, downscaled version of the base map for smoother performance.
// The original high-res PNG is still available in the project if needed.
L.imageOverlay("Gta5MapCayo_4k_q80.jpg", bounds).addTo(map);
map.fitBounds(bounds);

// Global state
let categories = {};
let dataSource = "categories.json"; // default (set on DOMContentLoaded)
const markersGroup = L.layerGroup().addTo(map);
let currentHighlightedMarker = null; // used for marker highlighting
let createMarkerMode = false;

// Simple in-memory image memo cache (Promise-based)
const imageLoadCache = new Map();
const localStorageKey = "echo-map-data-v1";
const firebaseDataPath = "echo-map-data";
let firebaseDb = null;
let firebaseAuth = null;
let firebaseSyncReady = false;
let firebaseSyncEnabled = false;
let firebaseSyncPromise = null;
const firebaseInvalidKeyPattern = /[.#$[\]/\u0000-\u001F\u007F]/;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeGuide(guide) {
  if (!guide) return null;

  if (typeof guide === "string") {
    const steps = guide
      .split(/\n+/)
      .map((step) => step.trim())
      .filter(Boolean);
    return { title: "Quick Guide", steps };
  }

  const stepList = Array.isArray(guide.steps)
    ? guide.steps.map((step) => String(step).trim()).filter(Boolean)
    : [];
  const bodyLines = typeof guide.body === "string"
    ? guide.body
        .split(/\n+/)
        .map((step) => step.trim())
        .filter(Boolean)
    : [];

  return {
    title: guide.title || "Quick Guide",
    steps: stepList.length ? stepList : bodyLines,
  };
}

function normalizeImages(rawLocation) {
  const values = [];

  const pushValue = (value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) values.push(trimmed);
    } else if (Array.isArray(value)) {
      value.forEach(pushValue);
    }
  };

  if (rawLocation?.images) {
    pushValue(rawLocation.images);
  } else if (rawLocation?.imgs) {
    pushValue(rawLocation.imgs);
  } else if (rawLocation?.img) {
    pushValue(rawLocation.img);
  }

  return values;
}

function normalizeLocation(rawLocation, categoryName, index) {
  const relatedItems = Array.isArray(rawLocation?.relatedItems)
    ? rawLocation.relatedItems.filter(Boolean).map((item) => String(item))
    : [];
  const images = normalizeImages(rawLocation);

  return {
    id: rawLocation?.id ?? Date.now() + index,
    lat: rawLocation?.lat != null ? String(rawLocation.lat) : "",
    lng: rawLocation?.lng != null ? String(rawLocation.lng) : "",
    name: rawLocation?.name || `${categoryName} ${index + 1}`,
    img: images[0] || rawLocation?.img || "",
    images,
    info: rawLocation?.info || "",
    relatedItems,
    guide: normalizeGuide(rawLocation?.guide),
  };
}

function normalizeCategories(rawCategories) {
  const normalized = {};
  for (const [categoryName, categoryData] of Object.entries(rawCategories || {})) {
    const locations = Array.isArray(categoryData?.locations)
      ? categoryData.locations.map((location, index) =>
          normalizeLocation(location, categoryName, index)
        )
      : [];

    normalized[categoryName] = {
      color: categoryData?.color || getCategoryColor(categoryName),
      icon: categoryData?.icon || categoryData?.iconName || categoryData?.iconify || null,
      locations,
    };
  }
  return normalized;
}

function isValidFirebaseKey(value) {
  return !!value && !firebaseInvalidKeyPattern.test(value);
}

function createPersistableLocation(rawLocation, categoryName, index) {
  const images = normalizeImages(rawLocation)
    .map((image) => image.slice(0, 2048))
    .slice(0, 20);
  const relatedItems = Array.isArray(rawLocation?.relatedItems)
    ? rawLocation.relatedItems
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .map((item) => item.slice(0, 500))
        .slice(0, 100)
    : [];
  const guide = normalizeGuide(rawLocation?.guide);
  const lat = rawLocation?.lat != null ? String(rawLocation.lat).slice(0, 32) : "";
  const lng = rawLocation?.lng != null ? String(rawLocation.lng).slice(0, 32) : "";
  const rawId = rawLocation?.id ?? `${categoryName}-${index}-${lat}-${lng}`;
  const location = {
    id: typeof rawId === "number" ? rawId : String(rawId).slice(0, 160),
    lat,
    lng,
    name: String(rawLocation?.name || `${categoryName} ${index + 1}`).trim().slice(0, 120),
    img: images[0] || "",
    images,
    info: String(rawLocation?.info || "").trim().slice(0, 1000),
    relatedItems,
  };

  if (guide?.steps?.length) {
    location.guide = {
      title: String(guide.title || "Quick Guide").trim().slice(0, 120),
      steps: guide.steps
        .map((step) => String(step).trim().slice(0, 1000))
        .filter(Boolean)
        .slice(0, 50),
    };
  }

  return location;
}

/**
 * Return only database-safe map data. Runtime Leaflet markers are deliberately
 * excluded so serialization and Firebase writes cannot traverse DOM/map state.
 */
function createPersistableCategories(sourceCategories = categories) {
  const payload = {};

  for (const [rawCategoryName, categoryData] of Object.entries(sourceCategories || {})) {
    if (!categoryData || typeof categoryData !== "object") continue;

    const categoryName = String(rawCategoryName).trim();
    if (!categoryName) continue;

    const persistentCategory = {
      color: String(categoryData.color || getCategoryColor(categoryName)).slice(0, 32),
      locations: Array.isArray(categoryData.locations)
        ? categoryData.locations.map((location, index) =>
            createPersistableLocation(location, categoryName, index)
          )
        : [],
    };
    const icon = categoryData.icon || categoryData.iconName || categoryData.iconify;
    if (icon) persistentCategory.icon = String(icon).trim().slice(0, 120);

    payload[categoryName] = persistentCategory;
  }

  return payload;
}

function getLocationIdentity(location) {
  if (location?.id != null && String(location.id).trim()) {
    return `id:${String(location.id)}`;
  }
  return `location:${location?.lat}|${location?.lng}|${location?.name}`;
}

function findCategoryForLocation(location) {
  if (!location) return null;
  const targetIdentity = getLocationIdentity(location);
  for (const [categoryName, categoryData] of Object.entries(categories || {})) {
    if (!categoryData || !Array.isArray(categoryData.locations)) continue;
    const match = categoryData.locations.find(
      (candidate) => getLocationIdentity(candidate) === targetIdentity
    );
    if (match) return categoryName;
  }
  return null;
}

function deleteLocation(location) {
  if (!location) return;
  const categoryName = findCategoryForLocation(location);
  if (!categoryName) return;

  const categoryData = categories[categoryName];
  if (!categoryData) return;

  const targetIdentity = getLocationIdentity(location);
  const wasDeleted = categoryData.locations.some(
    (candidate) => getLocationIdentity(candidate) === targetIdentity
  );
  if (!wasDeleted) return;

  if (!window.confirm(`Delete "${location.name || "this location"}"?`)) return;

  categoryData.locations = categoryData.locations.filter(
    (candidate) => getLocationIdentity(candidate) !== targetIdentity
  );

  if (categoryData.locations.length === 0) {
    delete categories[categoryName];
  }

  if (location.marker) {
    markersGroup.removeLayer(location.marker);
    location.marker = null;
  }

  if (currentHighlightedMarker && currentHighlightedMarker.getLatLng) {
    const activeLatLng = currentHighlightedMarker.getLatLng();
    if (!activeLatLng || (activeLatLng.lat === location.lat && activeLatLng.lng === location.lng)) {
      currentHighlightedMarker = null;
    }
  }

  const sidePopup = document.getElementById("side-popup");
  if (sidePopup) sidePopup.style.display = "none";

  void persistCategories().finally(() => {
    rebuildMap();
  });
}

async function clearAllLocations() {
  if (!window.confirm("Remove every location from this map and clear the shared data?")) return;
  categories = {};
  await persistCategories();
  rebuildMap();
}

/**
 * Merge incoming locations into the current database value without deleting
 * locations saved by another client. Existing records win on ID collisions.
 */
function getCategoryColor(categoryName) {
  const palette = ["#60a5fa", "#34d399", "#f59e0b", "#a78bfa", "#f472b6", "#fb923c"];
  const index = Math.abs(categoryName.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0)) % palette.length;
  return palette[index];
}

function updateSyncStatus(message) {
  const syncLabel = document.getElementById("sync-status");
  if (syncLabel) {
    syncLabel.textContent = `Sync: ${message}`;
  }
}

function isFirebaseConfigured() {
  const config = window.FIREBASE_CONFIG;
  return !!config && typeof config === "object" && config.projectId && !String(config.projectId).includes("YOUR_") && config.apiKey && !String(config.apiKey).includes("YOUR_");
}

function initializeFirebase() {
  if (!isFirebaseConfigured()) {
    firebaseSyncReady = false;
    firebaseSyncEnabled = false;
    updateSyncStatus("local");
    return Promise.resolve(false);
  }

  if (firebaseSyncPromise) return firebaseSyncPromise;

  firebaseSyncPromise = new Promise((resolve) => {
    try {
      if (!window.firebase?.apps?.length) {
        window.firebase.initializeApp(window.FIREBASE_CONFIG);
      }
      firebaseAuth = window.firebase.auth();
      firebaseDb = window.firebase.database();
      firebaseAuth
        .signInAnonymously()
        .then(() => {
          firebaseSyncReady = true;
          firebaseSyncEnabled = true;
          updateSyncStatus("Firebase");
          resolve(true);
        })
        .catch((error) => {
          console.warn("Firebase auth unavailable, using local persistence:", error);
          firebaseSyncReady = false;
          firebaseSyncEnabled = false;
          updateSyncStatus("local");
          resolve(false);
        });
    } catch (error) {
      console.warn("Firebase initialization failed, using local persistence:", error);
      firebaseSyncReady = false;
      firebaseSyncEnabled = false;
      updateSyncStatus("local");
      resolve(false);
    }
  });

  return firebaseSyncPromise;
}

function saveCategoriesLocally(payload) {
  try {
    localStorage.setItem(localStorageKey, JSON.stringify(payload));
    return { saved: true, error: null };
  } catch (error) {
    console.warn("Could not persist map data locally:", error);
    return { saved: false, error };
  }
}

async function persistCategories({ syncRemote = true } = {}) {
  const payload = createPersistableCategories(categories);
  const localResult = saveCategoriesLocally(payload);

  if (!syncRemote || !firebaseSyncEnabled || !firebaseDb) {
    if (localResult.saved && !firebaseSyncEnabled) updateSyncStatus("local");
    return {
      localSaved: localResult.saved,
      remoteSaved: false,
      remoteAttempted: false,
      error: localResult.error,
    };
  }

  const invalidCategory = Object.keys(payload).find(
    (categoryName) => categoryName.length > 80 || !isValidFirebaseKey(categoryName)
  );
  if (invalidCategory) {
    const error = new Error(
      `Category "${invalidCategory}" contains a character Firebase cannot store.`
    );
    console.warn(error.message);
    updateSyncStatus("local - invalid category name");
    return {
      localSaved: localResult.saved,
      remoteSaved: false,
      remoteAttempted: true,
      error,
    };
  }

  updateSyncStatus("saving...");

  try {
    await firebaseDb.ref(firebaseDataPath).set(payload);
    updateSyncStatus("Firebase");
    return {
      localSaved: localResult.saved,
      remoteSaved: true,
      remoteAttempted: true,
      error: localResult.error,
    };
  } catch (error) {
    console.warn("Could not sync map data to Firebase:", error);
    updateSyncStatus(localResult.saved ? "local - cloud failed" : "save failed");
    return {
      localSaved: localResult.saved,
      remoteSaved: false,
      remoteAttempted: true,
      error,
    };
  }
}

async function loadRemoteCategories() {
  if (!firebaseSyncEnabled || !firebaseDb) return null;

  try {
    const snapshot = await firebaseDb.ref(firebaseDataPath).once("value");
    const value = snapshot.val();
    if (value && typeof value === "object") {
      return normalizeCategories(value);
    }
    return null;
  } catch (error) {
    console.warn("Could not load map data from Firebase:", error);
    return null;
  }
}

function loadSharedCategoriesFromHash() {
  try {
    if (!window.location.hash.startsWith("#data=")) return null;
    const encoded = window.location.hash.slice("#data=".length);
    const decoded = decodeURIComponent(encoded);
    return normalizeCategories(JSON.parse(decoded));
  } catch (error) {
    console.warn("Could not load shared map data:", error);
    return null;
  }
}

function loadPersistedCategories() {
  try {
    const storedValue = localStorage.getItem(localStorageKey);
    if (!storedValue) return null;
    const parsed = JSON.parse(storedValue);
    return normalizeCategories(parsed);
  } catch (error) {
    console.warn("Could not load persisted map data:", error);
    return null;
  }
}

function resolveCategoryIcon(categoryName, categoryData) {
  const icon = categoryData?.icon || categoryData?.iconName || categoryData?.iconify;
  if (icon) return icon;

  const normalized = String(categoryName || "").toLowerCase();
  const defaults = {
    "container guy": "mdi:package-variant-closed",
    "money cleaning": "mdi:cash-multiple",
    "chop": "mdi:knife",
    "digital den": "mdi:monitor-cellphone-star",
    "trap houses": "mdi:home-group",
    "misc": "mdi:shape",
    "tradeables": "mdi:swap-horizontal",
    "jailbreak": "mdi:lock-open-variant",
    "meth labs": "mdi:flask",
    "acetone": "mdi:flask-outline",
    "coke stuff": "mdi:fire",
    "opium stuff": "mdi:flower-tulip",
    "meth stuff": "mdi:chemical-weapon",
  };

  for (const [match, candidate] of Object.entries(defaults)) {
    if (normalized.includes(match)) return candidate;
  }

  return "mdi:map-marker";
}

function buildCategoryIcons(categoriesByName) {
  const categoryIcons = {};
  for (const category in categoriesByName) {
    const color = categoriesByName[category].color;
    const iconName = resolveCategoryIcon(category, categoriesByName[category]);
    categoryIcons[category] = L.divIcon({
      className: "custom-div-icon",
      html: getPinHTML(color, iconName),
      iconSize: [44, 48],
      iconAnchor: [22, 48],
      popupAnchor: [0, -42],
    });
  }
  return categoryIcons;
}

function getLocationImages(location) {
  if (!location) return [];
  if (Array.isArray(location.images) && location.images.length) return location.images;
  if (typeof location.img === "string" && location.img.trim()) return [location.img.trim()];
  return [];
}

/**
 * Load an image once and memoize the Promise so reuses are instant.
 * Does NOT attach to DOM directly; it only ensures it's cached by the browser.
 */
function loadImage(url) {
  if (imageLoadCache.has(url)) return imageLoadCache.get(url);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(url);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
  imageLoadCache.set(url, p);
  return p;
}

/**
 * Optionally warm a small set of images in the background (no blocking).
 * Keeps things snappy without preloading everything.
 */
function warmCache(urls, limit = 8) {
  const toWarm = urls.slice(0, limit).filter((u) => !imageLoadCache.has(u));
  if (toWarm.length === 0) return;

  const run = () => {
    // Load sequentially but quietly
    (async () => {
      for (const url of toWarm) {
        try { await loadImage(url); } catch {}
      }
    })();
  };

  if ("requestIdleCallback" in window) {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 0);
  }
}

/**
 * Highlights the given marker (and unhighlights any previous marker)
 */
function highlightMarker(marker) {
  if (currentHighlightedMarker && currentHighlightedMarker !== marker) {
    const prevEl = currentHighlightedMarker.getElement();
    if (prevEl) prevEl.classList.remove("highlighted");
  }
  currentHighlightedMarker = marker;
  const el = marker.getElement();
  if (el) {
    el.classList.remove("highlighted");
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add("highlighted");
    // Keep the highlight persistent - don't remove it on animation end
    // This prevents pins from disappearing or becoming invisible after being clicked
  }
}

function rebuildMap() {
  markersGroup.clearLayers();
  const locationsListContainer = document.getElementById("locations-list-inner");
  if (locationsListContainer) {
    locationsListContainer.innerHTML = "";
  }

  const categoryIcons = buildCategoryIcons(categories);
  renderCategoriesAndMarkers(categoryIcons);
}

/**
 * Loads data from the given JSON file and builds the sidebar and markers.
 * No global image prefetching.
 */
function loadData(fileName) {
  const sharedCategories = loadSharedCategoriesFromHash();
  if (sharedCategories) {
    categories = sharedCategories;
    void persistCategories({ syncRemote: false });
    rebuildMap();
    void initializeFirebase();
    return;
  }

  const persistedCategories = loadPersistedCategories();
  if (persistedCategories) {
    categories = persistedCategories;
    rebuildMap();
  }

  initializeFirebase().then(async (enabled) => {
    if (!enabled) {
      if (!persistedCategories) {
        fetch(fileName)
          .then((response) => {
            if (!response.ok) throw new Error("Network response was not ok");
            return response.json();
          })
          .then((data) => {
            categories = normalizeCategories(data);
            void persistCategories({ syncRemote: false });
            rebuildMap();
          })
          .catch((error) => {
            console.error("Error loading JSON file:", error);
          });
      }
      return;
    }

    const remoteCategories = await loadRemoteCategories();
    if (remoteCategories !== null && remoteCategories !== undefined) {
      categories = normalizeCategories(remoteCategories);
      await persistCategories({ syncRemote: true });
      rebuildMap();
      updateSyncStatus("Firebase");
      return;
    }

    if (!persistedCategories) {
      fetch(fileName)
        .then((response) => {
          if (!response.ok) throw new Error("Network response was not ok");
          return response.json();
        })
        .then(async (data) => {
          categories = normalizeCategories(data);
          await persistCategories();
          rebuildMap();
        })
        .catch((error) => {
          console.error("Error loading JSON file:", error);
        });
    } else {
      await persistCategories();
      rebuildMap();
    }
  });
}

/**
 * Builds the sidebar and adds markers for each category.
 */
function renderCategoriesAndMarkers(categoryIcons) {
  const locationsListContainer = document.getElementById("locations-list-inner");
  const fragment = document.createDocumentFragment();

  for (const category in categories) {
    const categoryData = categories[category];
    const categoryColor = categoryData.color;

    const categoryContainer = document.createElement("div");
    categoryContainer.className = "category-container";

    const colorIndicator = document.createElement("div");
    colorIndicator.className = "color-indicator";
    colorIndicator.style.backgroundColor = categoryColor;

    const categoryName = document.createElement("span");
    categoryName.textContent = category;

    categoryContainer.appendChild(colorIndicator);
    categoryContainer.appendChild(categoryName);

    const accordionButton = document.createElement("button");
    accordionButton.className = "accordion";
    accordionButton.appendChild(categoryContainer);

    const panel = document.createElement("div");
    panel.className = "panel";

    // Collect image URLs so we can optionally warm a few on expand
    const categoryImageUrls = [];

    categoryData.locations.forEach((location) => {
      const latitude = Number.parseFloat(location.lat);
      const longitude = Number.parseFloat(location.lng);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        console.warn(`Skipping location with invalid coordinates: ${location.name}`);
        return;
      }

      const icon = categoryIcons[category];
      const marker = L.marker(
        [latitude, longitude],
        { icon: icon, title: location.name }
      ).addTo(markersGroup);
      location.marker = marker;

      // Keep track for warmCache later
      const images = getLocationImages(location);
      if (images.length) categoryImageUrls.push(...images);

      marker.on("click", function () {
        highlightMarker(this);
        showSidePopup(location);
      });

      const listItem = document.createElement("div");
      listItem.className = "locations-item";
      listItem.textContent = location.name;
      listItem.onclick = () => {
        focusLocation(location);
      };

      panel.appendChild(listItem);
    });

    // Expand/collapse
    accordionButton.addEventListener("click", function () {
      this.classList.toggle("active");
      const p = this.nextElementSibling;
      const willOpen = p.style.display !== "block";
      p.style.display = willOpen ? "block" : "none";

      // If opening, gently warm a small subset of this category's images
      if (willOpen && categoryImageUrls.length) {
        warmCache(categoryImageUrls, 6);
      }
    });

    fragment.appendChild(accordionButton);
    fragment.appendChild(panel);
  }

  locationsListContainer.appendChild(fragment);
}

/**
 * Recenters and zooms the map on the given location, then highlights it
 * and opens the side popup.
 */
function focusLocation(location, options = {}) {
  if (!location) return;
  const lat = parseFloat(location.lat);
  const lng = parseFloat(location.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return;

  const defaultZoom = 2.4;
  const requestedZoom =
    typeof options.zoom === "number" ? options.zoom : defaultZoom;
  const maxZoom = map.getMaxZoom() ?? 3;
  const minZoom = map.getMinZoom() ?? -10;
  const clampedZoom = Math.min(maxZoom, Math.max(requestedZoom, minZoom));

  map.setView([lat, lng], clampedZoom, { animate: true });

  setTimeout(() => {
    map.panBy([0, -120], { animate: true });
    if (location.marker) {
      highlightMarker(location.marker);
    }
    showSidePopup(location);
  }, 350);
}

/**
 * Displays a side popup with location details.
 * Image is lazy-loaded on demand and cached.
 */
function renderQuickGuide(location) {
  if (!location?.guide || !Array.isArray(location.guide.steps) || !location.guide.steps.length) {
    return "";
  }

  const steps = location.guide.steps
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join("");

  return `
    <div class="guide-card">
      <div class="guide-title">${escapeHtml(location.guide.title || "Quick Guide")}</div>
      <ul class="quick-guide-list">${steps}</ul>
    </div>
  `;
}

function renderLocationGallery(location) {
  const imageUrls = getLocationImages(location);

  if (!imageUrls.length) {
    return `
      <div id="side-img-wrap" style="width:100%; aspect-ratio: 16 / 9; background: rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; border-radius:6px; overflow:hidden; margin-bottom:10px;">
        <span id="side-img-loading" style="font-size:14px; opacity:0.8;">No image available.</span>
      </div>
    `;
  }

  const thumbs = imageUrls
    .map(
      (imageUrl, index) => `
        <button class="gallery-thumb" type="button" data-image-url="${escapeHtml(imageUrl)}" aria-label="Show image ${index + 1}">
          <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(location.name)} ${index + 1}" loading="lazy" />
        </button>
      `
    )
    .join("");

  return `
    <div class="gallery-shell">
      <div id="side-img-wrap" style="width:100%; aspect-ratio: 16 / 9; background: rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; border-radius:6px; overflow:hidden; margin-bottom:10px;">
        <span id="side-img-loading" style="font-size:14px; opacity:0.8;">Loading image…</span>
        <img id="side-img" alt="${escapeHtml(location.name)}" title="${escapeHtml(location.name)}" style="display:none; width:100%; height:100%; object-fit:contain; cursor:pointer;" loading="lazy" />
      </div>
      ${imageUrls.length > 1 ? `<div class="gallery-thumbs">${thumbs}</div>` : ""}
    </div>
  `;
}

function showSidePopup(location) {
  const infoText = location.info
    ? `<p style="margin-top: 5px; font-style: italic;">${escapeHtml(location.info)}</p>`
    : "";

  const relatedItemsText =
    location.relatedItems && Array.isArray(location.relatedItems) && location.relatedItems.length > 0
      ? `<div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.2);">
          <h3 style="margin: 0 0 8px 0; font-size: 14px;">Related Items</h3>
          <div style="display: flex; flex-wrap: wrap; gap: 6px;">
            ${location.relatedItems.map((item) => `<span style="background: rgba(255,255,255,0.15); padding: 4px 8px; border-radius: 4px; font-size: 12px;">${escapeHtml(item)}</span>`).join("")}
          </div>
        </div>`
      : "";

  const quickGuideText = renderQuickGuide(location);

  const content = `
    <div class="location-detail-card">
      <h1>${escapeHtml(location.name)}</h1>
      ${infoText}
      ${renderLocationGallery(location)}
      ${quickGuideText}
      ${relatedItemsText}
      <div style="margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap;">
        <button type="button" id="delete-location-button" class="popup-button delete-location-button">Delete Location</button>
      </div>
    </div>
  `;

  const popupContentEl = document.getElementById("side-popup-content");
  popupContentEl.innerHTML = content;
  document.getElementById("side-popup").style.display = "block";

  const imgEl = popupContentEl.querySelector("#side-img");
  const loadingEl = popupContentEl.querySelector("#side-img-loading");
  const imageUrls = getLocationImages(location);

  const showImage = (imageUrl) => {
    if (!imgEl || !imageUrl) return;

    loadImage(imageUrl)
      .then((url) => {
        imgEl.src = url;
        imgEl.style.display = "block";
        if (loadingEl) loadingEl.remove();
      })
      .catch(() => {
        if (loadingEl) loadingEl.textContent = "Failed to load image.";
      });
  };

  if (imageUrls.length) {
    showImage(imageUrls[0]);
  } else if (loadingEl) {
    loadingEl.textContent = "No image available.";
  }

  popupContentEl.querySelectorAll(".gallery-thumb").forEach((thumbButton) => {
    thumbButton.addEventListener("click", () => {
      const imageUrl = thumbButton.dataset.imageUrl;
      if (imageUrl) showImage(imageUrl);
    });
  });

  popupContentEl.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("#delete-location-button");
    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();
      deleteLocation(location);
    }
  });

  imgEl?.addEventListener("click", function () {
    if (imgEl.src) openModal(imgEl.src);
  });
}

/**
 * Opens the image modal for an enlarged view.
 */
function openModal(imageSrc) {
  const modal = document.getElementById("image-modal");
  const modalImg = document.getElementById("modal-image");
  modal.style.display = "block";
  modalImg.src = imageSrc;
  const closeBtn = document.getElementsByClassName("modal-close")[0];
  closeBtn.onclick = () => {
    modal.style.display = "none";
  };
  modal.onclick = () => {
    modal.style.display = "none";
  };
}

/**
 * Copies the given text to the clipboard.
 */
function copyToClipboard(text) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      console.log("Copied to clipboard successfully!");
    })
    .catch((err) => {
      console.error("Failed to copy text to clipboard:", err);
      alert(
        "Copying to clipboard failed. Ensure you are using HTTPS or localhost."
      );
    });
}

/**
 * Generates an SVG pin icon with the given color.
 */
function getPinHTML(color, iconName) {
  return `
    <div class="category-pin" style="--pin-color: ${color};">
      <div class="pin-bubble">
        <span class="iconify pin-icon" data-icon="${escapeHtml(iconName || "mdi:map-marker")}" data-inline="false"></span>
      </div>
    </div>
  `;
}

// Create a new marker via double-click on the map (unchanged utility)
map.on("dblclick", (e) => {
  createMarkerWithPopup(e.latlng);
});

// If create-marker mode is enabled, the very next single-click on the map
// will drop a marker at that location and open the editing popup.
map.on("click", (e) => {
  if (!createMarkerMode) return;
  createMarkerMode = false;
  createMarkerWithPopup(e.latlng);
});

function createMarkerWithPopup(latlng) {
  const marker = L.marker(latlng, { draggable: true }).addTo(map);
  marker._pendingSave = true;
  marker._saved = false;

  const categoryNames = Object.keys(categories).sort();
  const categoryOptions = categoryNames
    .map(
      (categoryName) =>
        `<option value="${escapeHtml(categoryName)}">${escapeHtml(categoryName)}</option>`
    )
    .join("");
  const createCategoryLabel = categoryNames.length ? "+ New category" : "Create a category";

  const popupContent = `
    <div class="create-location-form">
      <h3 class="create-location-title">Add Location</h3>

      <label class="create-location-label" for="marker-category-select">Category</label>
      <div class="category-select-shell">
        <span class="category-select-mark" aria-hidden="true">◆</span>
        <select id="marker-category-select" class="popup-input">
          ${categoryOptions}
          <option value="__new__">${createCategoryLabel}</option>
        </select>
      </div>
      <input id="marker-category-custom" type="text" class="popup-input" maxlength="80" placeholder="New category name" />

      <label class="create-location-label" for="marker-name">Location name <span>*</span></label>
      <input id="marker-name" type="text" class="popup-input" maxlength="120" placeholder="e.g. Meth Lab 1" />

      <label class="create-location-label" for="marker-category-icon">Category icon</label>
      <input id="marker-category-icon" type="text" class="popup-input" maxlength="120" placeholder="mdi:map-marker or heroicons:home" />
      <small class="create-location-help">Use an Iconify icon name, such as <code>mdi:map-marker</code>.</small>

      <div class="create-location-section">
        <label class="create-location-label">Images</label>
        <div id="image-urls-container" class="create-location-rows">
          <div class="image-url-row create-location-row">
            <input type="text" class="popup-input image-url-input" placeholder="https://..." />
            <button class="remove-image-url remove-location-row" type="button" aria-label="Remove image">&times;</button>
          </div>
        </div>
        <button id="add-image-url" class="add-location-row" type="button">+ Add image</button>
      </div>

      <label class="create-location-label" for="marker-info">Info</label>
      <input id="marker-info" type="text" class="popup-input" maxlength="1000" placeholder="e.g. Requires 5 thermite" />

      <label class="create-location-label" for="marker-guide-title">Quick guide title</label>
      <input id="marker-guide-title" type="text" class="popup-input" maxlength="120" placeholder="Quick Guide" />

      <label class="create-location-label" for="marker-guide-steps">Quick guide steps</label>
      <textarea id="marker-guide-steps" class="popup-input" rows="3" placeholder="One step per line"></textarea>

      <div class="create-location-section">
        <label class="create-location-label">Related items <span class="optional-label">(optional)</span></label>
        <small class="create-location-help">Items this location provides or uses.</small>
        <div id="related-items-container" class="create-location-rows">
          <div class="related-item-input create-location-row">
            <input type="text" class="popup-input related-item-name" placeholder="Item name" />
            <button class="remove-related-item remove-location-row" type="button" aria-label="Remove item">&times;</button>
          </div>
        </div>
        <button id="add-related-item" class="add-location-row" type="button">+ Add item</button>
      </div>

      <button id="save-marker" class="popup-button save-location-button" type="button">Save Location</button>
      <div id="marker-save-status" class="marker-save-status" role="status" aria-live="polite"></div>
    </div>
  `;
  marker.bindPopup(popupContent);
  setTimeout(() => marker.openPopup(), 50);

  marker.on("popupopen", () => {
    setTimeout(() => {
      const form = marker.getPopup()?.getElement()?.querySelector(".create-location-form");
      if (!form) return;

      const addItemBtn = form.querySelector("#add-related-item");
      const addImageBtn = form.querySelector("#add-image-url");
      const relatedItemsContainer = form.querySelector("#related-items-container");
      const imageUrlsContainer = form.querySelector("#image-urls-container");
      const categorySelect = form.querySelector("#marker-category-select");
      const categoryCustom = form.querySelector("#marker-category-custom");
      const saveButton = form.querySelector("#save-marker");
      const saveStatus = form.querySelector("#marker-save-status");

      const setSaveStatus = (message, type = "") => {
        if (!saveStatus) return;
        saveStatus.textContent = message;
        saveStatus.className = `marker-save-status${type ? ` ${type}` : ""}`;
      };

      form.addEventListener("click", (event) => {
        const removeItemButton = event.target.closest(".remove-related-item");
        if (removeItemButton) {
          removeItemButton.closest(".related-item-input")?.remove();
          return;
        }

        const removeImageButton = event.target.closest(".remove-image-url");
        if (removeImageButton) {
          removeImageButton.closest(".image-url-row")?.remove();
        }
      });

      if (addItemBtn && relatedItemsContainer) {
        addItemBtn.addEventListener("click", () => {
          const newItemDiv = document.createElement("div");
          newItemDiv.className = "related-item-input create-location-row";
          newItemDiv.innerHTML = `
            <input type="text" class="popup-input related-item-name" placeholder="Item name" />
            <button class="remove-related-item remove-location-row" type="button" aria-label="Remove item">&times;</button>
          `;
          relatedItemsContainer.appendChild(newItemDiv);
        });
      }

      if (addImageBtn && imageUrlsContainer) {
        addImageBtn.addEventListener("click", () => {
          const newImageRow = document.createElement("div");
          newImageRow.className = "image-url-row create-location-row";
          newImageRow.innerHTML = `
            <input type="text" class="popup-input image-url-input" placeholder="https://..." />
            <button class="remove-image-url remove-location-row" type="button" aria-label="Remove image">&times;</button>
          `;
          imageUrlsContainer.appendChild(newImageRow);
        });
      }

      if (categorySelect && categoryCustom) {
        const syncCustomCategoryVisibility = () => {
          categoryCustom.style.display = categorySelect.value === "__new__" ? "block" : "none";
        };
        categorySelect.addEventListener("change", syncCustomCategoryVisibility);
        syncCustomCategoryVisibility();
      }

      if (saveButton) {
        saveButton.addEventListener("click", async () => {
          if (saveButton.disabled) return;

          const nameInput = form.querySelector("#marker-name");
          const name = nameInput?.value.trim();
          if (!name) {
            setSaveStatus("Enter a location name before saving.", "error");
            nameInput?.focus();
            return;
          }
          if (name.length > 120) {
            setSaveStatus("Location names must be 120 characters or fewer.", "error");
            nameInput?.focus();
            return;
          }

          const categoryValue = categorySelect?.value === "__new__"
            ? categoryCustom?.value.trim()
            : categorySelect?.value.trim();
          const categoryName = categoryValue || "";
          if (!categoryName) {
            setSaveStatus("Choose a category or enter a new category name.", "error");
            categoryCustom?.focus();
            return;
          }
          if (categoryName.length > 80) {
            setSaveStatus("Category names must be 80 characters or fewer.", "error");
            categoryCustom?.focus();
            return;
          }
          if (!isValidFirebaseKey(categoryName)) {
            setSaveStatus('Category names cannot contain . # $ [ ] or / characters.', "error");
            categoryCustom?.focus();
            return;
          }

          const categoryIcon = form.querySelector("#marker-category-icon")?.value.trim() || null;
          const categoryWasNew = !categories[categoryName];
          const previousCategoryIcon = categories[categoryName]?.icon || null;

          if (!categories[categoryName]) {
            categories[categoryName] = {
              color: getCategoryColor(categoryName),
              icon: categoryIcon,
              locations: [],
            };
          } else if (categoryIcon) {
            categories[categoryName].icon = categoryIcon;
          }

          const relatedItems = [];
          form.querySelectorAll(".related-item-input").forEach((itemDiv) => {
            const itemName = itemDiv.querySelector(".related-item-name")?.value.trim();
            if (itemName) {
              relatedItems.push(itemName);
            }
          });

          const guideSteps = form.querySelector("#marker-guide-steps")?.value
            .split(/\n+/)
            .map((step) => step.trim())
            .filter(Boolean) || [];
          const guideTitle = form.querySelector("#marker-guide-title")?.value.trim() || "Quick Guide";
          const images = [];
          form.querySelectorAll(".image-url-input").forEach((imageInput) => {
            const imageUrl = imageInput.value.trim();
            if (imageUrl) images.push(imageUrl);
          });

          const finalPosition = marker.getLatLng();
          if (!Number.isFinite(finalPosition.lat) || !Number.isFinite(finalPosition.lng)) {
            setSaveStatus("This marker does not have valid map coordinates.", "error");
            return;
          }

          const locationId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

          const locationData = normalizeLocation(
            {
              id: locationId,
              lat: finalPosition.lat.toFixed(6),
              lng: finalPosition.lng.toFixed(6),
              name,
              img: images[0] || "",
              images,
              info: form.querySelector("#marker-info")?.value.trim() || "",
              relatedItems,
              guide: guideSteps.length
                ? { title: guideTitle, steps: guideSteps }
                : null,
            },
            categoryName,
            categories[categoryName].locations.length
          );

          categories[categoryName].locations.push(locationData);

          saveButton.disabled = true;
          saveButton.textContent = "Saving...";
          setSaveStatus("Saving this location...", "pending");
          const saveResult = await persistCategories();
          const saveSucceeded = saveResult.localSaved || saveResult.remoteSaved;

          if (!saveSucceeded) {
            categories[categoryName].locations = categories[categoryName].locations.filter(
              (location) => location.id !== locationId
            );
            if (categoryWasNew && categories[categoryName].locations.length === 0) {
              delete categories[categoryName];
            } else if (!categoryWasNew) {
              categories[categoryName].icon = previousCategoryIcon;
            }
            saveButton.disabled = false;
            saveButton.textContent = "Save Location";
            setSaveStatus("The location could not be saved. Check your connection and try again.", "error");
            return;
          }

          marker._saved = true;
          marker._pendingSave = false;
          rebuildMap();
          focusLocation(locationData, { zoom: 2.7 });

          if (isFirebaseConfigured() && !saveResult.remoteSaved) {
            alert("The location was saved on this device, but Firebase sync failed. It will be merged on a later successful sync.");
          }
        });
      }
    }, 10);
  });

  marker.on("popupclose", () => {
    if (marker._pendingSave && !marker._saved) {
      map.removeLayer(marker);
    }
  });
}

// Close side popup
document
  .getElementById("side-popup-close")
  .addEventListener("click", () => {
    document.getElementById("side-popup").style.display = "none";
  });

// Close image modal when clicking outside the modal content
window.onclick = (event) => {
  const imageModal = document.getElementById("image-modal");
  if (event.target === imageModal) {
    imageModal.style.display = "none";
  }
};

window.addEventListener("DOMContentLoaded", () => {
  dataSource = "categories.json";
  loadData(dataSource);

  // Header options toggle for the options container (simple show/hide)
  const optionsToggle = document.getElementById("options-toggle");
  const optionsContainer = document.getElementById("options-container");
  const closeOptionsButton = document.getElementById("close-options-button");
  const createMarkerButton = document.getElementById("create-marker-button");
  const clearAllButton = document.getElementById("clear-all-button");
  const searchInput = document.getElementById("location-search");
  const searchResults = document.getElementById("search-results");

  const exportButton = document.getElementById("export-button");
  const importButton = document.getElementById("import-button");
  const importFileInput = document.getElementById("import-file");

  if (optionsToggle && optionsContainer) {
    optionsToggle.addEventListener("click", () => {
      optionsContainer.classList.toggle("hidden");
    });
  }

  if (closeOptionsButton && optionsContainer) {
    closeOptionsButton.addEventListener("click", () => {
      optionsContainer.classList.add("hidden");
    });
  }

  if (exportButton) {
    exportButton.addEventListener("click", () => {
      const exportData = createPersistableCategories(categories);
      const exportJson = JSON.stringify(exportData, null, 2);
      const blob = new Blob([exportJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "map-data.json";
      anchor.click();
      URL.revokeObjectURL(url);
      navigator.clipboard?.writeText(exportJson).catch(() => {});
    });
  }

  if (importButton && importFileInput) {
    importButton.addEventListener("click", () => {
      importFileInput.click();
    });

    importFileInput.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Map data must be an object keyed by category name.");
          }
          const importedCategories = normalizeCategories(parsed);
          if (!Object.keys(importedCategories).length) {
            throw new Error("The imported file does not contain any categories.");
          }
          const previousCategories = categories;
          categories = importedCategories;
          const saveResult = await persistCategories();
          if (!saveResult.localSaved && !saveResult.remoteSaved) {
            categories = previousCategories;
            throw saveResult.error || new Error("Imported data could not be saved.");
          }
          rebuildMap();
          optionsContainer?.classList.add("hidden");
          if (isFirebaseConfigured() && !saveResult.remoteSaved) {
            alert("The import was saved locally, but Firebase sync failed.");
          }
        } catch (error) {
          console.error("Failed to import data:", error);
          alert("Import failed. Please choose a valid map JSON file.");
        }
      };
      reader.readAsText(file);
    });
  }

   // Wire up the "Create Marker" button so the next map click places a marker
  if (createMarkerButton && optionsContainer) {
    createMarkerButton.addEventListener("click", () => {
      createMarkerMode = true;
      optionsContainer.classList.add("hidden");
    });
  }

  if (clearAllButton) {
    clearAllButton.addEventListener("click", async () => {
      await clearAllLocations();
      optionsContainer?.classList.add("hidden");
    });
  }

  // Simple search over all locations by name and related items
  if (searchInput && searchResults) {
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.trim().toLowerCase();
      searchResults.innerHTML = "";

      if (!query) {
        searchResults.style.display = "none";
        // Show all markers
        for (const category in categories) {
          const categoryData = categories[category];
          if (!categoryData || !Array.isArray(categoryData.locations)) continue;
          categoryData.locations.forEach((location) => {
            if (location.marker) {
              markersGroup.addLayer(location.marker);
            }
          });
        }
        return;
      }

      const matches = [];
      const matchedLocationIds = new Set();
      
      for (const category in categories) {
        const categoryData = categories[category];
        if (!categoryData || !Array.isArray(categoryData.locations)) continue;
        categoryData.locations.forEach((location) => {
          // Check if location name matches
          const nameMatches = location.name && location.name.toLowerCase().includes(query);
          
          // Check if any related item matches and capture which ones
          const matchingRelatedItems = 
            location.relatedItems && 
            Array.isArray(location.relatedItems) && 
            location.relatedItems.filter(item => item.toLowerCase().includes(query));
          
          const relatedItemMatches = matchingRelatedItems && matchingRelatedItems.length > 0;

          // Include location if name matches OR related item matches
          if (nameMatches || relatedItemMatches) {
            matches.push({ location, category, matchedRelatedItems: matchingRelatedItems || [] });
            matchedLocationIds.add(location.name); // Track matched locations
          }
        });
      }

      // Hide all markers first
      for (const category in categories) {
        const categoryData = categories[category];
        if (!categoryData || !Array.isArray(categoryData.locations)) continue;
        categoryData.locations.forEach((location) => {
          if (location.marker) {
            markersGroup.removeLayer(location.marker);
          }
        });
      }

      // Show only matched markers
      matches.forEach(({ location }) => {
        if (location.marker) {
          markersGroup.addLayer(location.marker);
        }
      });

      if (!matches.length) {
        searchResults.style.display = "none";
        return;
      }

      searchResults.style.display = "block";
      matches.slice(0, 25).forEach(({ location, category, matchedRelatedItems }) => {
        const item = document.createElement("div");
        item.className = "search-result-item";
        
        // Build display text with matched related items highlighted
        let displayText = `${location.name} · ${category}`;
        if (matchedRelatedItems && matchedRelatedItems.length > 0) {
          displayText += ` [${matchedRelatedItems.join(", ")}]`;
        }
        
        item.textContent = displayText;
        item.addEventListener("click", () => {
          focusLocation(location, { zoom: 2.7 });
          searchInput.blur();
        });
        searchResults.appendChild(item);
      });
    });
  }
});

// Set the initial zoom level (if needed)
map.setZoom(1);
