-- ArticleSearch was a denormalized contains-search copy without a real FTS index.
-- Article list search now reads the existing Article fields directly.
DROP TABLE "article_search";
