import { defineCatalog } from "./format";

/** GIF favorites copy, split from ./messaging.ts so the shared catalog does not
 *  grow the lazy settings chunk that re-bundles it. */
export const gifFavoritesText = defineCatalog("gifFavorites", {
  tabsLabel: "GIF sources",
  tabBrowse: "Trending",
  tabFavorites: "Favorites",
  favoritesEmpty: "No favorites yet. Star a GIF to save it here.",
  favorite: "Add to favorites",
  unfavorite: "Remove from favorites",
  favoriteFailed: "Couldn't update favorites",
  favoritesFull: "You've reached the limit of saved GIFs. Remove one to add another.",
});
