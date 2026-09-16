import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { buildReport } from "./client";
import { querySchema } from "./contract";
import { fixture } from "./fixture";

if (typeof document === "undefined") GlobalRegistrator.register();

test("dashboard sends JSON-safe queries, drills into a day, changes views, and clears data when machine is deselected", async () => {
  const queries: Record<string, unknown>[] = [];
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      hosts: () => ({ hosts: [{ id: "one", name: "Laptop" }], defaultHostId: "one" }),
      query: input => {
        const query = input as Record<string, unknown>;
        for (const value of Object.values(query)) expect(value).not.toBeUndefined();
        queries.push(query);
        const { hostId, ...fields } = query;
        return buildReport(fixture, querySchema.parse(fields), "local hub");
      },
    },
  });
  try {
    await slot.findByText("Built the plugin");
    expect(queries[0]).toEqual({ hostId: "one", view: "days", offset: 0, limit: 7 });
    fireEvent.click(slot.getByRole("button", { name: "Trails 15m" }));
    await slot.findByText("Connected Trails to BB");
    expect(queries.at(-1)).toMatchObject({ view: "projects", date: "2026-09-15", project: "code/trails" });
    fireEvent.click(slot.getByRole("button", { name: /^Status$/ }));
    await slot.findByText("Collectors");
    expect(queries.at(-1)).not.toHaveProperty("date");
    expect(queries.at(-1)).not.toHaveProperty("project");
    fireEvent.change(slot.getByRole("combobox", { name: "Machine" }), { target: { value: "" } });
    await waitFor(() => expect(slot.queryByText("Collectors")).toBeNull());
  } finally { slot.lifecycle.unmount(); }
});


test("failed manual refresh preserves the last result and recovery clears the error", async () => {
  let offline = false;
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      hosts: () => ({ hosts: [{ id: "one", name: "Laptop" }], defaultHostId: "one" }),
      query: () => {
        if (offline) throw new Error("Trails is unavailable");
        return buildReport(fixture, querySchema.parse({}), "local hub");
      },
    },
  });
  try {
    await slot.findByText("Built the plugin");
    offline = true;
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await slot.findByText("Showing the last successful refresh.");
    expect(slot.queryByText("Built the plugin")).not.toBeNull();
    offline = false;
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
    expect(slot.queryByText("Built the plugin")).not.toBeNull();
  } finally { slot.lifecycle.unmount(); }
});
