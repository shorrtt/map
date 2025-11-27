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

// Simple in-memory image memo cache (Promise-based)
const imageLoadCache = new Map();

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

/**
 * Loads data from the given JSON file and builds the sidebar and markers.
 * No global image prefetching.
 */
function loadData(fileName) {
  markersGroup.clearLayers();
  const locationsListContainer = document.getElementById("locations-list-inner");
  if (locationsListContainer) {
    locationsListContainer.innerHTML = "";
  }

  fetch(fileName)
    .then((response) => {
      if (!response.ok) throw new Error("Network response was not ok");
      return response.json();
    })
    .then((data) => {
      categories = data;

      // Build a simple colored pin icon per category
      const categoryIcons = {};
      for (const category in categories) {
        const color = categories[category].color;
        categoryIcons[category] = L.divIcon({
          className: "custom-div-icon",
          html: getPinSVG(color),
          iconSize: [32, 32],
          popupAnchor: [0, -10],
        });
      }

      loadCategories(categoryIcons);
    })
    .catch((error) => {
      console.error("Error loading JSON file:", error);
    });
}

/**
 * Builds the sidebar and adds markers for each category.
 */
function loadCategories(categoryIcons) {
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
      const icon = categoryIcons[category];
      const marker = L.marker(
        [parseFloat(location.lat), parseFloat(location.lng)],
        { icon: icon, title: location.name }
      ).addTo(markersGroup);
      location.marker = marker;

      // Keep track for warmCache later
      if (location.img) categoryImageUrls.push(location.img);

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
function showSidePopup(location) {
  // Use either Info or info field
  const infoText =
    location.Info || location.info
      ? `<p style="margin-top: 5px; font-style: italic;">${
          location.Info || location.info
        }</p>`
      : "";

  // Build related items section
  const relatedItemsText = 
    location.relatedItems && Array.isArray(location.relatedItems) && location.relatedItems.length > 0
      ? `<div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.2);">
          <h3 style="margin: 0 0 8px 0; font-size: 14px;">Related Items</h3>
          <div style="display: flex; flex-wrap: wrap; gap: 6px;">
            ${location.relatedItems.map(item => `<span style="background: rgba(255,255,255,0.15); padding: 4px 8px; border-radius: 4px; font-size: 12px;">${item}</span>`).join('')}
          </div>
        </div>`
      : "";

  // Skeleton placeholder for image while loading
  const content = `
    <h1>${location.name}</h1>
    ${infoText}
    <div id="side-img-wrap" style="width:100%; aspect-ratio: 16 / 9; background: rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; border-radius:6px; overflow:hidden; margin-bottom:10px;">
      <span id="side-img-loading" style="font-size:14px; opacity:0.8;">Loading image…</span>
      <img id="side-img" alt="${location.name}" title="${location.name}" style="display:none; width:100%; height:100%; object-fit:contain; cursor:pointer;" loading="lazy" />
    </div>
    ${relatedItemsText}
  `;

  const popupContentEl = document.getElementById("side-popup-content");
  popupContentEl.innerHTML = content;
  document.getElementById("side-popup").style.display = "block";

  const imgEl = popupContentEl.querySelector("#side-img");
  const loadingEl = popupContentEl.querySelector("#side-img-loading");

  if (location.img) {
    // Load only now, then show
    loadImage(location.img)
      .then((url) => {
        imgEl.src = url;
        imgEl.style.display = "block";
        if (loadingEl) loadingEl.remove();
      })
      .catch(() => {
        if (loadingEl) loadingEl.textContent = "Failed to load image.";
      });
  } else {
    if (loadingEl) loadingEl.textContent = "No image available.";
  }

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
function getPinSVG(color) {
  return `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30">
        <circle cx="12" cy="9.5" r="6" fill="${color}" stroke="#000000" stroke-width="2" />
        <circle cx="12" cy="9.5" r="2.4" fill="rgba(15,23,42,0.95)" />
        <rect x="11" y="13.5" width="2" height="6.5" rx="1" fill="${color}" />
        <circle cx="12" cy="21" r="2.4" fill="rgba(15,23,42,0.5)" />
      </svg>
  `;
}

// Create a new marker via double-click on the map (unchanged utility)
map.on("dblclick", (e) => {
  createMarkerWithPopup(e.latlng);
});

// Simple "create marker" mode toggled from the options dialog.
let createMarkerMode = false;

// If create-marker mode is enabled, the very next single-click on the map
// will drop a marker at that location and open the editing popup.
map.on("click", (e) => {
  if (!createMarkerMode) return;
  createMarkerMode = false;
  createMarkerWithPopup(e.latlng);
});

function createMarkerWithPopup(latlng) {
  console.log("Creating marker at latlng:", latlng);
  const marker = L.marker(latlng, { draggable: true }).addTo(map);
  const popupContent = `
    <div style="min-width: 300px; max-width: 400px;">
      <h3 style="margin-top: 0; color: var(--text-primary);">Create Marker</h3>
      
      <label for="marker-name" style="display: block; margin-top: 12px; font-weight: 600; font-size: 13px; color: var(--text-muted);">Location Name *</label>
      <input id="marker-name" type="text" class="popup-input" placeholder="e.g. Meth Lab 1"/><br>
      
      <label for="marker-img" style="display: block; margin-top: 12px; font-weight: 600; font-size: 13px; color: var(--text-muted);">Image URL</label>
      <input id="marker-img" type="text" class="popup-input" placeholder="https://..."/><br>
      
      <label for="marker-info" style="display: block; margin-top: 12px; font-weight: 600; font-size: 13px; color: var(--text-muted);">Info</label>
      <input id="marker-info" type="text" class="popup-input" placeholder="e.g. Requires 5 thermite"/><br>
      
      <label style="display: block; margin-top: 12px; font-weight: 600; font-size: 13px; color: var(--text-muted);">Related Items (optional)</label>
      <small style="color: var(--text-muted); display: block; margin-bottom: 8px;">Add items this location provides/uses</small>
      
      <div id="related-items-container" style="margin-bottom: 12px;">
        <div class="related-item-input" style="display: flex; gap: 8px; margin-bottom: 8px;">
          <input type="text" class="popup-input related-item-name" placeholder="Item name" style="flex: 1; margin: 0;"/>
          <input type="text" class="popup-input related-item-desc" placeholder="Description (optional)" style="flex: 1; margin: 0;"/>
          <button class="remove-related-item" style="padding: 8px 12px; background: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer; min-width: 40px;">×</button>
        </div>
      </div>
      
      <button id="add-related-item" style="width: 100%; padding: 8px; margin-bottom: 12px; background: rgba(59, 130, 246, 0.2); color: #3b82f6; border: 1px solid #3b82f6; border-radius: 4px; cursor: pointer; font-size: 12px;">+ Add Item</button>
      
      <button id="copy-marker" class="popup-button">Copy to Clipboard</button>
    </div>
  `;
  marker.bindPopup(popupContent);
  setTimeout(() => marker.openPopup(), 50);

  marker.on("popupopen", () => {
    setTimeout(() => {
      // Add related item button
      const addItemBtn = document.getElementById("add-related-item");
      const relatedItemsContainer = document.getElementById("related-items-container");
      
      if (addItemBtn) {
        addItemBtn.addEventListener("click", () => {
          const newItemDiv = document.createElement("div");
          newItemDiv.className = "related-item-input";
          newItemDiv.style.cssText = "display: flex; gap: 8px; margin-bottom: 8px;";
          newItemDiv.innerHTML = `
            <input type="text" class="popup-input related-item-name" placeholder="Item name" style="flex: 1; margin: 0;"/>
            <input type="text" class="popup-input related-item-desc" placeholder="Description (optional)" style="flex: 1; margin: 0;"/>
            <button class="remove-related-item" style="padding: 8px 12px; background: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer; min-width: 40px;">×</button>
          `;
          relatedItemsContainer.appendChild(newItemDiv);
          
          // Add remove listener to new item
          setupRemoveButtons();
        });
      }
      
      // Setup remove buttons
      const setupRemoveButtons = () => {
        const removeButtons = document.querySelectorAll(".remove-related-item");
        removeButtons.forEach(btn => {
          btn.onclick = (e) => {
            e.target.closest(".related-item-input").remove();
          };
        });
      };
      
      setupRemoveButtons();
      
      const copyButton = document.getElementById("copy-marker");
      if (copyButton) {
        copyButton.addEventListener("click", () => {
          const name = document.getElementById("marker-name").value;
          const imgUrl = document.getElementById("marker-img").value;
          const info = document.getElementById("marker-info").value;
          
          // Collect related items
          const relatedItems = [];
          document.querySelectorAll(".related-item-input").forEach(itemDiv => {
            const itemName = itemDiv.querySelector(".related-item-name").value.trim();
            if (itemName) {
              relatedItems.push(itemName);
            }
          });
          
          const markerData = {
            id: Date.now(),
            lat: latlng.lat.toFixed(6),
            lng: latlng.lng.toFixed(6),
            name: name || "New Location",
            img: imgUrl || "",
            info: info || "",
            relatedItems: relatedItems,
          };
          const formattedData = JSON.stringify(markerData);
          copyToClipboard(formattedData);
          marker.bindPopup(`<p>Marker copied to clipboard!</p>`).openPopup();
          setTimeout(() => {
            map.removeLayer(marker);
          }, 1500);
        });
      } else {
        console.error("Copy button not found.");
      }
    }, 10);
  });

  marker.on("popupclose", () => {
    map.removeLayer(marker);
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
  const searchInput = document.getElementById("location-search");
  const searchResults = document.getElementById("search-results");

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

   // Wire up the "Create Marker" button so the next map click places a marker
  if (createMarkerButton && optionsContainer) {
    createMarkerButton.addEventListener("click", () => {
      createMarkerMode = true;
      optionsContainer.classList.add("hidden");
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
