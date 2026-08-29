// The generated SDK operation shape and its discovery rules belong here.

import ts from "typescript";
import { httpMethods } from "./openapi.mjs";
import {
  hasExportModifier,
  objectPropertyName,
  parseTypeScript,
} from "./typescript.mjs";

export function discoverOperations(filename, source) {
  const sourceFile = parseTypeScript(filename, source);
  const operations = new Map();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !hasExportModifier(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.initializer === undefined ||
        !ts.isArrowFunction(declaration.initializer)
      ) {
        continue;
      }
      const arrow = declaration.initializer;
      if (
        arrow.parameters.length !== 1 ||
        arrow.parameters[0].type === undefined ||
        !ts.isTypeReferenceNode(arrow.parameters[0].type) ||
        !ts.isIdentifier(arrow.parameters[0].type.typeName) ||
        arrow.parameters[0].type.typeName.text !== "Options"
      ) {
        continue;
      }
      const context = `Generated operation ${declaration.name.text}`;
      let expression = arrow.body;
      while (ts.isParenthesizedExpression(expression)) {
        expression = expression.expression;
      }
      if (!ts.isCallExpression(expression)) {
        throw new TypeError(`${context} must have an expression-bodied call`);
      }
      const clientMethod = expression.expression;
      if (
        !ts.isPropertyAccessExpression(clientMethod) ||
        !ts.isPropertyAccessExpression(clientMethod.expression) ||
        !ts.isIdentifier(clientMethod.expression.expression) ||
        clientMethod.expression.expression.text !== "options" ||
        clientMethod.expression.name.text !== "client" ||
        !httpMethods.has(clientMethod.name.text)
      ) {
        throw new TypeError(`${context} must call options.client.<method>`);
      }
      if (
        expression.arguments.length !== 1 ||
        !ts.isObjectLiteralExpression(expression.arguments[0])
      ) {
        throw new TypeError(`${context} must pass one object literal argument`);
      }
      const urls = expression.arguments[0].properties.filter(
        (property) => objectPropertyName(property) === "url",
      );
      if (
        urls.length !== 1 ||
        !ts.isPropertyAssignment(urls[0]) ||
        !ts.isStringLiteral(urls[0].initializer)
      ) {
        throw new TypeError(`${context} must contain one string-literal URL`);
      }
      const method = clientMethod.name.text;
      const url = urls[0].initializer.text;
      const route = `${method.toUpperCase()} ${url}`;
      if (operations.has(route)) {
        throw new TypeError(`Duplicate generated operation ${route}`);
      }
      if (expression.typeArguments?.length !== 3) {
        throw new TypeError(
          `${context} client call must have three type arguments`,
        );
      }
      if (expression.typeArguments[2].getText(sourceFile) !== "ThrowOnError") {
        throw new TypeError(
          `${context} has an invalid client ThrowOnError type`,
        );
      }
      const errorsType = expression.typeArguments[1];
      operations.set(route, {
        arrow,
        call: expression,
        name: declaration.name.text,
        method,
        url,
        object: expression.arguments[0],
        errorsType:
          ts.isTypeReferenceNode(errorsType) &&
          ts.isIdentifier(errorsType.typeName)
            ? errorsType.typeName.text
            : undefined,
        sourceFile,
      });
    }
  }
  return operations;
}
