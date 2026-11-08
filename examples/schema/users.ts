import { table, int, text } from "symmetria";

export const users = table({
  id: int.auto,
  email: text.unique,
  name: text,
});
