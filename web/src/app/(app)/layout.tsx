import { connection } from "next/server";

import { AppSidebar } from "@/components/app-sidebar";
import { BrowseProvider } from "@/components/browse/browse-dialog";
import { GraphDock } from "@/components/graph/graph-dock";
import { GraphDockProvider } from "@/components/graph/graph-dock-context";
import { MobileNavProvider, MobileTopBar } from "@/components/mobile-nav";
import { SearchProvider } from "@/components/search/search-dialog";
import { SettingsProvider } from "@/components/settings/settings-dialog";
import { ShareDialogProvider } from "@/components/share/share-dialog";
import { EditorTabs } from "@/components/tabs/editor-tabs";
import { TabsProvider } from "@/components/tabs/tabs-context";
import { TrashProvider } from "@/components/trash/trash-dialog";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { AUTH_MODE } from "@/lib/auth";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // AUTH_MODE is a runtime setting (it picks the sidebar's sign-in/out flow);
  // never prerender with the build environment's value.
  await connection();
  return (
    <ConfirmProvider>
      <ToastProvider>
        <TabsProvider>
          <GraphDockProvider>
            <SearchProvider>
              <SettingsProvider>
                <ShareDialogProvider>
                  <BrowseProvider>
                    <TrashProvider>
                      <MobileNavProvider>
                        <div className="flex h-screen">
                          <AppSidebar authMode={AUTH_MODE} />
                          <main className="flex min-w-0 flex-1 flex-col">
                            <MobileTopBar />
                            <EditorTabs />
                            <div className="flex min-h-0 flex-1">
                              <div className="min-w-0 flex-1 overflow-y-auto">
                                {children}
                              </div>
                              <GraphDock />
                            </div>
                          </main>
                        </div>
                      </MobileNavProvider>
                    </TrashProvider>
                  </BrowseProvider>
                </ShareDialogProvider>
              </SettingsProvider>
            </SearchProvider>
          </GraphDockProvider>
        </TabsProvider>
      </ToastProvider>
    </ConfirmProvider>
  );
}
