FROM golang:1.25 AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -o /out/chartdb-live-sync .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/chartdb-live-sync /chartdb-live-sync
VOLUME ["/data/live-sync"]
EXPOSE 8090
ENTRYPOINT ["/chartdb-live-sync"]
