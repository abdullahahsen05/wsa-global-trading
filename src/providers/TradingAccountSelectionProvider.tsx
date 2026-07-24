"use client";

import { createContext, useContext, useMemo, useState } from "react";

type TradingAccountSelectionContextValue = {
  selectedAccountId: string | null;
  setSelectedAccountId: (accountId: string | null) => void;
};

const TradingAccountSelectionContext =
  createContext<TradingAccountSelectionContextValue | null>(null);

export function TradingAccountSelectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const value = useMemo(
    () => ({ selectedAccountId, setSelectedAccountId }),
    [selectedAccountId],
  );

  return (
    <TradingAccountSelectionContext.Provider value={value}>
      {children}
    </TradingAccountSelectionContext.Provider>
  );
}

export function useTradingAccountSelection() {
  const context = useContext(TradingAccountSelectionContext);
  if (!context) {
    throw new Error(
      "useTradingAccountSelection must be used within TradingAccountSelectionProvider",
    );
  }
  return context;
}
