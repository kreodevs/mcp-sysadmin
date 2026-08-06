import { InventoryStore } from "../config/loader.js";
import { Inventory } from "../config/schema.js";
import { ProviderRegistry } from "../providers/registry.js";

export type ToolContext = {
  inventory: InventoryStore;
  registry: ProviderRegistry;
  defaults?: Inventory["defaults"];
};

export function createToolContext(): ToolContext {
  const inventory = InventoryStore.load();
  const registry = new ProviderRegistry(inventory);
  return { inventory, registry, defaults: inventory.defaults };
}
