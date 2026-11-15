import { randomUUID } from "node:crypto";
import {
  CreatePackagePriceSchema,
  CreateProductFeatureSchema,
  CreateProductPackageSchema,
  CreateProductSchema,
  UpdatePackagePriceSchema,
  UpdateProductFeatureSchema,
  UpdateProductPackageSchema,
  UpdateProductSchema,
  validateFeatureEntitlementValue,
} from "../../../../../packages/contracts/src/index.ts";
import type {
  PackagePriceRecord,
  PackageVersionFeatureGrant,
  PackageVersionRecord,
  ProductFeatureRecord,
  ProductPackageRecord,
  ProductRecord,
  StackMateDataStore,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

export async function createProduct(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string
): Promise<ProductRecord> {
  assertStaffPermission(actor, "products.create");
  const input = CreateProductSchema.parse(rawInput);

  return store.withTransaction((state) => {
    if (state.products.some((p) => p.code === input.code)) {
      throw new AppError("CONFLICT", `Product code '${input.code}' already exists.`, 409);
    }
    if (state.products.some((p) => p.slug === input.slug)) {
      throw new AppError("CONFLICT", `Product slug '${input.slug}' already exists.`, 409);
    }

    const defaultChannels =
      input.distribution_channels ??
      (input.product_type === "wordpress_plugin" || input.product_type === "wordpress_theme"
        ? ["wordpress"]
        : input.product_type === "saas_application"
          ? ["hosted_saas"]
          : input.product_type === "dedicated_deployment"
            ? ["dedicated_deployment"]
            : input.product_type === "digital_service"
              ? ["service_delivery"]
              : ["api"]);

    const now = new Date().toISOString();
    const product: ProductRecord = {
      id: randomUUID(),
      code: input.code,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      product_type: input.product_type,
      fulfillment_type:
        input.product_type === "digital_service" ? "digital_service" : input.fulfillment_type,
      distribution_channels: [...defaultChannels],
      default_activation_limit: input.default_activation_limit,
      offline_grace_hours: input.offline_grace_hours,
      status: "draft",
      website_url: input.website_url ?? null,
      documentation_url: input.documentation_url ?? null,
      created_by_user_id: actor.user.id,
      created_at: now,
      updated_at: now,
    };

    state.products.push(product);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.product.created",
      resource_type: "product",
      resource_id: product.id,
      outcome: "success",
      request_id: requestId,
      changes: { code: product.code, slug: product.slug, product_type: product.product_type },
    });
    return product;
  });
}

export async function updateProductStatus(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  productId: string,
  nextStatus: "active" | "archived",
  requestId: string
): Promise<ProductRecord> {
  assertStaffPermission(actor, "products.update");
  return store.withTransaction((state) => {
    const product = state.products.find((p) => p.id === productId);
    if (!product) {
      throw new AppError("NOT_FOUND", "Product not found.", 404);
    }
    const prev = product.status;
    product.status = nextStatus;
    product.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: `catalog.product.${nextStatus === "active" ? "published" : "archived"}`,
      resource_type: "product",
      resource_id: product.id,
      outcome: "success",
      request_id: requestId,
      changes: { from_status: prev, to_status: nextStatus },
    });
    return product;
  });
}

export async function updateProductMetadata(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  productId: string,
  rawInput: unknown,
  requestId: string
): Promise<ProductRecord> {
  assertStaffPermission(actor, "products.update");
  const input = UpdateProductSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const product = state.products.find((p) => p.id === productId);
    if (!product) throw new AppError("NOT_FOUND", "Product not found.", 404);
    if (input.name !== undefined) product.name = input.name;
    if (input.description !== undefined) product.description = input.description;
    if (input.website_url !== undefined) product.website_url = input.website_url;
    if (input.documentation_url !== undefined) product.documentation_url = input.documentation_url;
    product.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.product.updated",
      resource_type: "product",
      resource_id: product.id,
      outcome: "success",
      request_id: requestId,
      changes: input as Record<string, unknown>,
    });
    return product;
  });
}

export async function createProductFeature(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  productId: string,
  rawInput: unknown,
  requestId: string
): Promise<ProductFeatureRecord> {
  assertStaffPermission(actor, "features.manage");
  const input = CreateProductFeatureSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const product = state.products.find((p) => p.id === productId);
    if (!product) throw new AppError("NOT_FOUND", "Product not found.", 404);
    if (
      state.product_features.some(
        (f) => f.product_id === productId && f.feature_key === input.feature_key
      )
    ) {
      throw new AppError(
        "CONFLICT",
        `Feature key '${input.feature_key}' already exists for product '${product.code}'.`,
        409
      );
    }

    let validatedDefault: unknown = null;
    if (input.default_value !== undefined) {
      try {
        validatedDefault = validateFeatureEntitlementValue(input.value_type, input.default_value);
      } catch (err) {
        throw new AppError("VALIDATION_ERROR", (err as Error).message, 422);
      }
    }

    const now = new Date().toISOString();
    const feature: ProductFeatureRecord = {
      id: randomUUID(),
      product_id: productId,
      feature_key: input.feature_key,
      name: input.name,
      description: input.description ?? null,
      value_type: input.value_type,
      unit: input.unit ?? null,
      default_value: validatedDefault,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    state.product_features.push(feature);

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.feature.created",
      resource_type: "product_feature",
      resource_id: feature.id,
      outcome: "success",
      request_id: requestId,
      changes: { product_id: productId, feature_key: feature.feature_key, value_type: feature.value_type },
    });
    return feature;
  });
}

export async function createProductPackageWithDraftVersion(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  productId: string,
  rawInput: unknown,
  requestId: string
): Promise<{ package: ProductPackageRecord; version: PackageVersionRecord }> {
  assertStaffPermission(actor, "packages.manage");
  const input = CreateProductPackageSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const product = state.products.find((p) => p.id === productId);
    if (!product) throw new AppError("NOT_FOUND", "Product not found.", 404);
    if (
      state.product_packages.some(
        (pkg) => pkg.product_id === productId && pkg.package_key === input.package_key
      )
    ) {
      throw new AppError(
        "CONFLICT",
        `Package key '${input.package_key}' already exists for product '${product.code}'.`,
        409
      );
    }

    const versionId = randomUUID();
    const featureGrants: PackageVersionFeatureGrant[] = [];
    const seenFeatures = new Set<string>();

    for (const fInput of input.features) {
      if (seenFeatures.has(fInput.product_feature_id)) {
        throw new AppError("VALIDATION_ERROR", "Duplicate feature in package version.", 422);
      }
      seenFeatures.add(fInput.product_feature_id);
      const featureDef = state.product_features.find((f) => f.id === fInput.product_feature_id);
      if (!featureDef) {
        throw new AppError("NOT_FOUND", `Feature '${fInput.product_feature_id}' not found.`, 404);
      }
      // Critical Invariant (TAD §9.2 #2, Database Design §10.3): Reject cross-product features
      if (featureDef.product_id !== productId) {
        throw new AppError(
          "CROSS_PRODUCT_FEATURE_ERROR",
          `Feature '${featureDef.feature_key}' belongs to another product and cannot be attached to package '${input.package_key}'.`,
          422
        );
      }
      let typedValue: unknown;
      try {
        typedValue = validateFeatureEntitlementValue(featureDef.value_type, fInput.entitlement_value);
      } catch (err) {
        throw new AppError("VALIDATION_ERROR", (err as Error).message, 422);
      }

      featureGrants.push({
        id: randomUUID(),
        package_version_id: versionId,
        product_id: productId,
        product_feature_id: featureDef.id,
        feature_key_snapshot: featureDef.feature_key,
        value_type_snapshot: featureDef.value_type,
        entitlement_value: typedValue,
        unit_snapshot: featureDef.unit,
      });
    }

    const now = new Date().toISOString();
    const pkg: ProductPackageRecord = {
      id: randomUUID(),
      product_id: productId,
      package_key: input.package_key,
      name: input.name,
      description: input.description ?? null,
      status: "draft",
      current_version_id: versionId,
      created_at: now,
      updated_at: now,
    };

    const version: PackageVersionRecord = {
      id: versionId,
      package_id: pkg.id,
      product_id: productId,
      version_number: 1,
      status: "draft",
      change_summary: input.change_summary ?? "Initial version",
      features: featureGrants,
      published_at: null,
      created_at: now,
    };

    state.product_packages.push(pkg);
    state.package_versions.push(version);

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.package.created",
      resource_type: "product_package",
      resource_id: pkg.id,
      outcome: "success",
      request_id: requestId,
      changes: { package_key: pkg.package_key, version_number: 1, features_count: featureGrants.length },
    });

    return { package: pkg, version };
  });
}

export async function createNewPackageVersion(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  packageId: string,
  rawInput: {
    features: Array<{ product_feature_id: string; entitlement_value: unknown }>;
    change_summary?: string;
  },
  requestId: string
): Promise<PackageVersionRecord> {
  assertStaffPermission(actor, "packages.manage");
  return store.withTransaction((state) => {
    const pkg = state.product_packages.find((p) => p.id === packageId);
    if (!pkg) throw new AppError("NOT_FOUND", "Package not found.", 404);

    const existingVersions = state.package_versions.filter((v) => v.package_id === packageId);
    const maxVer = existingVersions.reduce((acc, v) => Math.max(acc, v.version_number), 0);
    const nextVersionNumber = maxVer + 1;
    const versionId = randomUUID();
    const featureGrants: PackageVersionFeatureGrant[] = [];

    for (const fInput of rawInput.features) {
      const featureDef = state.product_features.find((f) => f.id === fInput.product_feature_id);
      if (!featureDef) {
        throw new AppError("NOT_FOUND", `Feature '${fInput.product_feature_id}' not found.`, 404);
      }
      if (featureDef.product_id !== pkg.product_id) {
        throw new AppError(
          "CROSS_PRODUCT_FEATURE_ERROR",
          `Feature '${featureDef.feature_key}' does not belong to the package's product.`,
          422
        );
      }
      const typedValue = validateFeatureEntitlementValue(
        featureDef.value_type,
        fInput.entitlement_value
      );
      featureGrants.push({
        id: randomUUID(),
        package_version_id: versionId,
        product_id: pkg.product_id,
        product_feature_id: featureDef.id,
        feature_key_snapshot: featureDef.feature_key,
        value_type_snapshot: featureDef.value_type,
        entitlement_value: typedValue,
        unit_snapshot: featureDef.unit,
      });
    }

    const version: PackageVersionRecord = {
      id: versionId,
      package_id: pkg.id,
      product_id: pkg.product_id,
      version_number: nextVersionNumber,
      status: "draft",
      change_summary: rawInput.change_summary ?? `Version ${nextVersionNumber}`,
      features: featureGrants,
      published_at: null,
      created_at: new Date().toISOString(),
    };

    state.package_versions.push(version);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.package_version.created",
      resource_type: "package_version",
      resource_id: version.id,
      outcome: "success",
      request_id: requestId,
      changes: { package_id: pkg.id, version_number: nextVersionNumber },
    });
    return version;
  });
}

export async function publishPackageVersion(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  versionId: string,
  requestId: string
): Promise<PackageVersionRecord> {
  assertStaffPermission(actor, "packages.publish");
  return store.withTransaction((state) => {
    const version = state.package_versions.find((v) => v.id === versionId);
    if (!version) throw new AppError("NOT_FOUND", "Package version not found.", 404);
    if (version.status === "published") {
      throw new AppError(
        "PACKAGE_VERSION_IMMUTABLE",
        "Package version is already published and immutable.",
        409
      );
    }
    if (version.status === "retired") {
      throw new AppError("PACKAGE_VERSION_IMMUTABLE", "Retired package version cannot be republished.", 409);
    }

    const pkg = state.product_packages.find((p) => p.id === version.package_id);
    if (!pkg) throw new AppError("NOT_FOUND", "Parent package not found.", 404);

    const now = new Date().toISOString();
    version.status = "published";
    version.published_at = now;
    pkg.status = "active";
    pkg.current_version_id = version.id;
    pkg.updated_at = now;

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.package_version.published",
      resource_type: "package_version",
      resource_id: version.id,
      outcome: "success",
      request_id: requestId,
      changes: { package_id: pkg.id, version_number: version.version_number },
    });

    return version;
  });
}

export async function createPackagePrice(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  versionId: string,
  rawInput: unknown,
  requestId: string
): Promise<PackagePriceRecord> {
  assertStaffPermission(actor, "packages.manage");
  const input = CreatePackagePriceSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const version = state.package_versions.find((v) => v.id === versionId);
    if (!version) throw new AppError("NOT_FOUND", "Package version not found.", 404);
    if (
      state.package_prices.some(
        (p) => p.package_version_id === versionId && p.price_key === input.price_key
      )
    ) {
      throw new AppError(
        "CONFLICT",
        `Price key '${input.price_key}' already exists on this package version.`,
        409
      );
    }

    const price: PackagePriceRecord = {
      id: randomUUID(),
      package_version_id: versionId,
      price_key: input.price_key,
      price_kind: input.price_kind,
      amount_minor: input.amount_minor,
      currency_code: input.currency_code.toUpperCase(),
      interval_unit: input.interval_unit ?? null,
      interval_count: input.interval_count ?? null,
      trial_days: input.trial_days,
      setup_fee_minor: input.setup_fee_minor,
      status: "active",
      used_in_orders: false,
      created_at: new Date().toISOString(),
    };
    state.package_prices.push(price);

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.price.created",
      resource_type: "package_price",
      resource_id: price.id,
      outcome: "success",
      request_id: requestId,
      changes: {
        package_version_id: versionId,
        price_key: price.price_key,
        amount_minor: price.amount_minor,
        currency_code: price.currency_code,
      },
    });
    return price;
  });
}

export async function updateProductFeatureByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  productId: string,
  featureId: string,
  rawInput: unknown,
  requestId: string
): Promise<ProductFeatureRecord> {
  assertStaffPermission(actor, "features.manage");
  const input = UpdateProductFeatureSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const feature = state.product_features.find(
      (f) => f.id === featureId && f.product_id === productId
    );
    if (!feature) throw new AppError("NOT_FOUND", "Product feature not found.", 404);

    if (input.default_value !== undefined) {
      try {
        feature.default_value = validateFeatureEntitlementValue(
          feature.value_type,
          input.default_value
        );
      } catch (err) {
        throw new AppError("VALIDATION_ERROR", (err as Error).message, 422);
      }
    }
    if (input.name !== undefined) feature.name = input.name;
    if (input.description !== undefined) feature.description = input.description;
    if (input.unit !== undefined) feature.unit = input.unit;
    feature.updated_at = new Date().toISOString();

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.feature.updated",
      resource_type: "product_feature",
      resource_id: feature.id,
      outcome: "success",
      request_id: requestId,
      changes: input as Record<string, unknown>,
    });
    return feature;
  });
}

export async function archiveProductFeatureByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  productId: string,
  featureId: string,
  requestId: string
): Promise<ProductFeatureRecord> {
  assertStaffPermission(actor, "features.manage");
  return store.withTransaction((state) => {
    const feature = state.product_features.find(
      (f) => f.id === featureId && f.product_id === productId
    );
    if (!feature) throw new AppError("NOT_FOUND", "Product feature not found.", 404);
    if (feature.status === "archived") {
      throw new AppError("CONFLICT", "Feature is already archived.", 409);
    }
    // A feature referenced by a published package version must keep
    // working for existing grants — refuse to archive it while published.
    const usedByPublished = state.package_versions.some(
      (v) =>
        v.status === "published" &&
        v.features.some((g) => g.product_feature_id === feature.id)
    );
    if (usedByPublished) {
      throw new AppError(
        "CONFLICT",
        "Feature is referenced by a published package version and cannot be archived. Retire the published version first.",
        409
      );
    }
    feature.status = "archived";
    feature.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.feature.archived",
      resource_type: "product_feature",
      resource_id: feature.id,
      outcome: "success",
      request_id: requestId,
      changes: { feature_key: feature.feature_key },
    });
    return feature;
  });
}

export async function updateProductPackageByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  packageId: string,
  rawInput: unknown,
  requestId: string
): Promise<ProductPackageRecord> {
  assertStaffPermission(actor, "packages.manage");
  const input = UpdateProductPackageSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const pkg = state.product_packages.find((p) => p.id === packageId);
    if (!pkg) throw new AppError("NOT_FOUND", "Package not found.", 404);
    if (input.name !== undefined) pkg.name = input.name;
    if (input.description !== undefined) pkg.description = input.description;
    pkg.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.package.updated",
      resource_type: "product_package",
      resource_id: pkg.id,
      outcome: "success",
      request_id: requestId,
      changes: input as Record<string, unknown>,
    });
    return pkg;
  });
}

export async function retirePackageVersionByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  versionId: string,
  requestId: string
): Promise<PackageVersionRecord> {
  assertStaffPermission(actor, "packages.publish");
  return store.withTransaction((state) => {
    const version = state.package_versions.find((v) => v.id === versionId);
    if (!version) throw new AppError("NOT_FOUND", "Package version not found.", 404);
    if (version.status === "retired") {
      throw new AppError("CONFLICT", "Package version is already retired.", 409);
    }
    if (version.status === "draft") {
      throw new AppError(
        "CONFLICT",
        "Only a published version can be retired. Draft versions are never sold.",
        409
      );
    }
    const pkg = state.product_packages.find((p) => p.id === version.package_id);
    if (!pkg) throw new AppError("NOT_FOUND", "Parent package not found.", 404);

    version.status = "retired";
    // The retired version stops being the purchasable current version.
    if (pkg.current_version_id === version.id) {
      pkg.current_version_id = null;
      pkg.status = "draft";
      pkg.updated_at = new Date().toISOString();
    }
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.package_version.retired",
      resource_type: "package_version",
      resource_id: version.id,
      outcome: "success",
      request_id: requestId,
      changes: { package_id: pkg.id, version_number: version.version_number },
    });
    return version;
  });
}

export async function updatePackagePriceByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  priceId: string,
  rawInput: unknown,
  requestId: string
): Promise<PackagePriceRecord> {
  assertStaffPermission(actor, "packages.manage");
  const input = UpdatePackagePriceSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const price = state.package_prices.find((p) => p.id === priceId);
    if (!price) throw new AppError("NOT_FOUND", "Package price not found.", 404);
    // API Spec §9.4: a price already used in orders is immutable —
    // create a replacement price instead of editing history.
    if (price.used_in_orders) {
      throw new AppError(
        "CONFLICT",
        "Price has already been used in orders and cannot be edited. Create a replacement price instead.",
        409
      );
    }
    // Interval configuration must stay consistent with the (immutable) price_kind.
    const nextIntervalUnit =
      input.interval_unit !== undefined ? input.interval_unit : price.interval_unit;
    const nextIntervalCount =
      input.interval_count !== undefined ? input.interval_count : price.interval_count;
    if (price.price_kind === "recurring") {
      if (!nextIntervalUnit || !nextIntervalCount) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Recurring prices require interval_unit and interval_count.",
          422
        );
      }
    } else {
      if (nextIntervalUnit || nextIntervalCount) {
        throw new AppError(
          "VALIDATION_ERROR",
          `A ${price.price_kind} price must not carry interval_unit/interval_count.`,
          422
        );
      }
    }
    if (price.price_kind === "free") {
      const nextAmount = input.amount_minor ?? price.amount_minor;
      const nextSetup = input.setup_fee_minor ?? price.setup_fee_minor;
      if (nextAmount !== 0 || nextSetup !== 0) {
        throw new AppError("VALIDATION_ERROR", "Free prices must stay at zero amount.", 422);
      }
    }
    if (input.amount_minor !== undefined) price.amount_minor = input.amount_minor;
    if (input.currency_code !== undefined) price.currency_code = input.currency_code.toUpperCase();
    if (input.interval_unit !== undefined) price.interval_unit = input.interval_unit;
    if (input.interval_count !== undefined) price.interval_count = input.interval_count;
    if (input.trial_days !== undefined) price.trial_days = input.trial_days;
    if (input.setup_fee_minor !== undefined) price.setup_fee_minor = input.setup_fee_minor;

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.price.updated",
      resource_type: "package_price",
      resource_id: price.id,
      outcome: "success",
      request_id: requestId,
      changes: input as Record<string, unknown>,
    });
    return price;
  });
}

export async function disablePackagePriceByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  priceId: string,
  requestId: string
): Promise<PackagePriceRecord> {
  assertStaffPermission(actor, "packages.manage");
  return store.withTransaction((state) => {
    const price = state.package_prices.find((p) => p.id === priceId);
    if (!price) throw new AppError("NOT_FOUND", "Package price not found.", 404);
    if (price.status === "inactive") {
      throw new AppError("CONFLICT", "Price is already disabled.", 409);
    }
    // The price status vocabulary is active | inactive | retired
    // (migration 0000 CHECK); "inactive" is the disabled state — the
    // public catalogue only exposes status === "active" prices.
    price.status = "inactive";
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "catalog.price.disabled",
      resource_type: "package_price",
      resource_id: price.id,
      outcome: "success",
      request_id: requestId,
      changes: { price_key: price.price_key },
    });
    return price;
  });
}
