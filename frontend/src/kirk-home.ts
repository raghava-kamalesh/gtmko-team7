import members from "../../shared/kirk-members.json";
import type { KirkHome } from "./types";

const placeholders: Record<string, string> = {
  grocery: "/images/category-1.svg",
  household: "/images/category-2.svg",
  electronics: "/images/category-3.svg",
  furniture: "/images/category-4.svg",
  outdoor: "/images/category-5.svg",
};

export function fallbackKirkHome(memberKey = "demo"): KirkHome {
  const profile = (members.members as Record<string, {
    displayName: string; email?: string; historyCategoryIds: string[];
    unmetInterests: Array<{ text: string; category: string }>;
  }>)[memberKey] ?? members.members.demo;
  const history = members.categories.filter((category) => profile.historyCategoryIds.includes(category.id));
  return {
    member: {
      key: memberKey,
      displayName: profile.displayName,
      email: profile.email ?? null,
      unmetInterests: profile.unmetInterests,
      history: profile.historyCategoryIds,
    },
    suggestions: history.map((category) => ({
      id: category.id,
      label: category.label,
      prompt: category.prompt,
      reason: category.reason,
      heroUrl: placeholders[category.id] ?? "/images/category-1.svg",
      heroSource: "placeholder",
    })),
    preorderItems: [],
    notifications: [],
  };
}
