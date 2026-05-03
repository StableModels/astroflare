import { defineCollection, z } from "@astroflare/content";

const blog = defineCollection({
	schema: z.object({
		title: z.string(),
		pubDate: z.string().or(z.date()),
		tags: z.array(z.string()).default([]),
	}),
});

export const collections = { blog };
