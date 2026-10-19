import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer, PendingTurn, SuggestionCards } from "./ChatParts";

function Harness({ onSubmit, sending = false }: { onSubmit: (v: string) => void; sending?: boolean }) {
  const [v, setV] = useState("");
  return <ChatComposer value={v} onChange={setV} onSubmit={() => onSubmit(v)} label="Ask" sending={sending} />;
}

describe("Ask Witness chat parts", () => {
  it("composer: Enter sends, Shift+Enter adds a newline, empty input never sends", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox", { name: "Ask" });
    await user.type(box, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two");
    expect(box).toHaveValue("line one\nline two");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(box, "{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("line one\nline two");
  });

  it("composer: cannot send while a question is in flight", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} sending />);
    await user.type(screen.getByRole("textbox", { name: "Ask" }), "hello{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sending" })).toBeDisabled();
  });

  it("pending turn shows a typing indicator, then the inline error with Retry and Edit question", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    const { rerender } = render(<PendingTurn question="Why?" sending error={null} onRetry={onRetry} onEdit={onEdit} />);
    expect(screen.getByText("Why?")).toBeInTheDocument();
    expect(screen.getByTestId("typing-indicator")).toBeInTheDocument();
    rerender(<PendingTurn question="Why?" sending={false} error={<p>database busy</p>} onRetry={onRetry} onEdit={onEdit} />);
    expect(screen.queryByTestId("typing-indicator")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await user.click(screen.getByRole("button", { name: "Edit question" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("suggestion cards call back with the prompt", async () => {
    const onPick = vi.fn();
    render(<SuggestionCards suggestions={["A?", "B?"]} onPick={onPick} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "B?" }));
    expect(onPick).toHaveBeenCalledWith("B?");
  });
});
